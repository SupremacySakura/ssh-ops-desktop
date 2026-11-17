use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use opspilot_domain::{CoreError, CoreErrorCode, Host};
use sha2::{Digest, Sha256};

const MAX_SSH_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSshServer {
    host: String,
    port: u16,
    username: String,
}

impl OpenSshServer {
    pub fn try_new(host: &str, port: u32, username: &str) -> Result<Self, CoreError> {
        let host = validate_atom(host, "OpenSSH host")?.to_lowercase();
        let username = validate_atom(username, "OpenSSH username")?;
        if host.contains("://")
            || !host.chars().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_' | ':')
            })
        {
            return Err(validation("OpenSSH host contains unsupported characters"));
        }
        if !username
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
        {
            return Err(validation(
                "OpenSSH username contains unsupported characters",
            ));
        }
        let port = u16::try_from(port)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| validation("OpenSSH port must be between 1 and 65535"))?;
        Ok(Self {
            host,
            port,
            username,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSshArgs {
    program: PathBuf,
    arguments: Vec<String>,
}

impl OpenSshArgs {
    pub fn for_server(server: &OpenSshServer) -> Result<Self, CoreError> {
        Ok(Self {
            program: PathBuf::from("ssh"),
            arguments: vec![
                "-p".to_owned(),
                server.port.to_string(),
                "--".to_owned(),
                format!("{}@{}", server.username, server.host),
            ],
        })
    }

    pub fn with_program(mut self, program: impl AsRef<Path>) -> Result<Self, CoreError> {
        let program = program.as_ref();
        if !program.is_absolute() || !program.is_file() {
            return Err(validation(
                "OpenSSH executable must be an existing absolute file",
            ));
        }
        self.program = program.to_owned();
        Ok(self)
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.arguments).env_clear();
        for name in ["PATH", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshConfigEntry {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<String>,
    pub unsupported_directives: Vec<String>,
    pub warnings: Vec<SshConfigWarning>,
    pub importable: bool,
    pub trusted_host_key: bool,
    pub private_key_copied: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshConfigWarning {
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshConfigParse {
    pub entries: Vec<SshConfigEntry>,
    pub warnings: Vec<SshConfigWarning>,
}

pub struct SshConfigImporter;

impl SshConfigImporter {
    pub fn parse(source: &str) -> Result<SshConfigParse, CoreError> {
        let mut parser = Parser::default();
        for (index, raw_line) in source.lines().enumerate() {
            let line_number = index + 1;
            if raw_line.trim().is_empty() {
                continue;
            }

            let Some(tokens) = tokenize_line(raw_line) else {
                parser.handle_unterminated_line(raw_line, line_number);
                continue;
            };
            if tokens.is_empty() {
                continue;
            }

            let directive = tokens[0].as_str();
            if directive.eq_ignore_ascii_case("Host") {
                parser.start_host(&tokens[1..], line_number);
                continue;
            }
            if directive.eq_ignore_ascii_case("Match") {
                parser.start_match(line_number);
                continue;
            }
            if parser.inside_match {
                let directive_name = canonical_directive(directive);
                if directive_affects_import(directive) {
                    parser.block_globally(
                        line_number,
                        format!(
                            "Match 条件块中的 {directive_name} 会影响匹配 Host 的目标或认证语义，暂不支持；全部明确 Host 已停用导入。"
                        ),
                    );
                } else {
                    parser.warning(
                        line_number,
                        format!("Match 条件块中的 {directive_name} 暂不支持，已忽略。"),
                    );
                }
                continue;
            }

            if parser.current.is_some() {
                parser.apply_host_directive(directive, &tokens[1..], line_number);
            } else if directive.eq_ignore_ascii_case("include")
                || directive_affects_import(directive)
            {
                parser.block_globally(
                    line_number,
                    format!(
                        "顶层的 {} 会影响所有明确 Host 的目标或认证语义，暂不支持；全部导入项已停用。",
                        canonical_directive(directive)
                    ),
                );
            } else {
                parser.warning(
                    line_number,
                    format!(
                        "不属于任何 Host 的 {} 暂不支持，未纳入导入。",
                        canonical_directive(directive)
                    ),
                );
            }
        }
        parser.finish_current();

        if !parser.saw_host_declaration {
            return Err(validation("SSH Config 格式异常：未发现有效的 Host 条目"));
        }
        if let Some(first) = parser.global_blockers.first() {
            let count = parser.global_blockers.len();
            let mut summary = format!(
                "文件级配置包含未支持语义（第 {} 行：{}）",
                first.line, first.message
            );
            if count > 1 {
                summary.push_str(&format!("，另有 {} 条", count - 1));
            }
            summary.push_str("；该 Host 已停用，避免按错误目标直连。");
            for entry in &mut parser.entries {
                if entry.importable {
                    entry.importable = false;
                    entry.warnings.push(SshConfigWarning {
                        line: first.line,
                        message: summary.clone(),
                    });
                }
            }
        }

        Ok(SshConfigParse {
            entries: parser.entries,
            warnings: parser.warnings,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshConfigFile {
    pub source: String,
    pub sha256: String,
}

pub fn read_ssh_config(path: &Path) -> Result<SshConfigFile, CoreError> {
    let metadata = fs::metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => CoreError::new(
            CoreErrorCode::NotFound,
            "未找到 SSH Config 文件，请确认 ~/.ssh/config 存在",
            false,
        ),
        std::io::ErrorKind::PermissionDenied => CoreError::new(
            CoreErrorCode::Internal,
            "没有权限读取 SSH Config 文件，请检查文件权限",
            false,
        ),
        _ => CoreError::new(
            CoreErrorCode::Internal,
            "无法读取 SSH Config 文件，请重试",
            true,
        ),
    })?;
    if !metadata.is_file() {
        return Err(validation("SSH Config 路径不是普通文件"));
    }
    if metadata.len() > MAX_SSH_CONFIG_BYTES {
        return Err(validation("SSH Config 文件超过 1 MiB，无法导入"));
    }

    let file = fs::File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            CoreError::new(
                CoreErrorCode::Internal,
                "没有权限读取 SSH Config 文件，请检查文件权限",
                false,
            )
        } else {
            CoreError::new(
                CoreErrorCode::Internal,
                "无法读取 SSH Config 文件，请重试",
                true,
            )
        }
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_SSH_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            CoreError::new(
                CoreErrorCode::Internal,
                "无法读取 SSH Config 文件，请重试",
                true,
            )
        })?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SSH_CONFIG_BYTES {
        return Err(validation("SSH Config 文件超过 1 MiB，无法导入"));
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let source =
        String::from_utf8(bytes).map_err(|_| validation("SSH Config 不是有效的 UTF-8 文本"))?;

    Ok(SshConfigFile { source, sha256 })
}

#[derive(Debug, Default)]
struct Parser {
    entries: Vec<SshConfigEntry>,
    warnings: Vec<SshConfigWarning>,
    global_blockers: Vec<SshConfigWarning>,
    current: Option<HostBlock>,
    inside_match: bool,
    saw_host_declaration: bool,
}

#[derive(Debug)]
struct HostBlock {
    declaration_line: usize,
    aliases: Vec<String>,
    wildcard: bool,
    discard: bool,
    host_name: Option<String>,
    username: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    unsupported: Vec<(usize, String)>,
    warnings: Vec<SshConfigWarning>,
    blocked: bool,
    invalid: bool,
}

impl HostBlock {
    fn invalid(declaration_line: usize) -> Self {
        Self {
            declaration_line,
            aliases: Vec::new(),
            wildcard: false,
            discard: false,
            host_name: None,
            username: None,
            port: None,
            identity_file: None,
            unsupported: Vec::new(),
            warnings: Vec::new(),
            blocked: false,
            invalid: true,
        }
    }
}

impl Parser {
    fn warning(&mut self, line: usize, message: impl Into<String>) {
        self.warnings.push(SshConfigWarning {
            line,
            message: message.into(),
        });
    }

    fn block_globally(&mut self, line: usize, message: impl Into<String>) {
        let warning = SshConfigWarning {
            line,
            message: message.into(),
        };
        if !self.global_blockers.contains(&warning) {
            self.global_blockers.push(warning.clone());
            self.warnings.push(warning);
        }
    }

    fn handle_unterminated_line(&mut self, raw_line: &str, line: usize) {
        let directive = leading_directive(raw_line).map(str::to_ascii_lowercase);
        match directive.as_deref() {
            Some("host") => {
                self.finish_current();
                self.inside_match = false;
                self.warning(
                    line,
                    "Host 行引号未闭合，该配置块已忽略；后续指令不会附加到上一个 Host。",
                );
                self.current = Some(HostBlock::invalid(line));
            }
            Some("match") => {
                self.finish_current();
                self.inside_match = true;
                self.warning(line, "Match 行引号未闭合，其后的条件配置已忽略。");
            }
            Some(directive) => {
                if let Some(current) = &mut self.current {
                    current.invalid = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: format!(
                            "{} 行引号未闭合；该 Host 已跳过，避免错误归属后续指令。",
                            canonical_directive(directive)
                        ),
                    });
                } else if directive_affects_import(directive) {
                    self.block_globally(
                        line,
                        format!(
                            "{} 行引号未闭合，无法安全解释其全局影响；全部明确 Host 已停用导入。",
                            canonical_directive(directive)
                        ),
                    );
                } else {
                    self.warning(line, "该行引号未闭合，已忽略。");
                }
            }
            None => {
                if let Some(current) = &mut self.current {
                    current.invalid = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "该行引号未闭合；该 Host 已跳过，避免错误归属后续指令。"
                            .to_owned(),
                    });
                } else {
                    self.warning(line, "该行引号未闭合，已忽略。");
                }
            }
        }
    }

    fn start_host(&mut self, aliases: &[String], line: usize) {
        self.finish_current();
        self.inside_match = false;
        if aliases.is_empty() {
            self.warning(line, "Host 缺少名称，已忽略该行。");
            return;
        }

        self.saw_host_declaration = true;
        let wildcard = aliases.iter().any(|alias| is_pattern(alias));
        let mut block_aliases = Vec::new();
        let mut discard = false;
        if !wildcard {
            for alias in aliases {
                if valid_alias(alias) {
                    block_aliases.push(alias.clone());
                } else {
                    discard = true;
                    self.warning(line, format!("Host 名称 {alias} 无效，该配置块已被忽略。"));
                }
            }
        }
        self.current = Some(HostBlock {
            declaration_line: line,
            aliases: block_aliases,
            wildcard,
            discard,
            host_name: None,
            username: None,
            port: None,
            identity_file: None,
            unsupported: Vec::new(),
            warnings: Vec::new(),
            blocked: false,
            invalid: false,
        });
    }

    fn start_match(&mut self, line: usize) {
        let warning = "Match 条件配置暂不支持；其后的条件不会附加到上一个 Host。";
        if let Some(current) = &mut self.current {
            current.blocked = true;
            current.warnings.push(SshConfigWarning {
                line,
                message: warning.to_owned(),
            });
        } else {
            self.warning(line, warning);
        }
        self.finish_current();
        self.inside_match = true;
    }

    fn apply_host_directive(&mut self, directive: &str, values: &[String], line: usize) {
        let Some(current) = self.current.as_mut() else {
            return;
        };
        let directive_name = canonical_directive(directive);
        match directive.to_ascii_lowercase().as_str() {
            "hostname" => {
                if current.host_name.is_some() {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "重复的 HostName 已忽略；OpenSSH 采用首次获得的值。".to_owned(),
                    });
                    return;
                }
                if values.len() != 1 {
                    current.invalid = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "HostName 必须是一个主机名，该 Host 已跳过。".to_owned(),
                    });
                    return;
                }
                current.host_name = Some(values[0].clone());
            }
            "user" => {
                if current.username.is_some() {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "重复的 User 已忽略；OpenSSH 采用首次获得的值。".to_owned(),
                    });
                    return;
                }
                if values.len() != 1 || !valid_username(&values[0]) {
                    current.invalid = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "User 无效，该 Host 已跳过。".to_owned(),
                    });
                    return;
                }
                current.username = Some(values[0].clone());
            }
            "port" => {
                if current.port.is_some() {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "重复的 Port 已忽略；OpenSSH 采用首次获得的值。".to_owned(),
                    });
                    return;
                }
                let port = (values.len() == 1)
                    .then(|| values[0].parse::<u16>().ok())
                    .flatten()
                    .filter(|port| *port > 0);
                if let Some(port) = port {
                    current.port = Some(port);
                } else {
                    current.invalid = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "端口必须在 1–65535 之间，该 Host 已跳过。".to_owned(),
                    });
                }
            }
            "identityfile" => {
                if current.identity_file.is_some() {
                    return;
                }
                if values.is_empty() {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "IdentityFile 缺少路径；私钥不会被复制。".to_owned(),
                    });
                    return;
                }
                current.identity_file = Some(values.join(" "));
                if values.len() > 1 {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: "IdentityFile 含多个未引用片段，仅显示第一个提示路径。".to_owned(),
                    });
                }
            }
            "proxyjump" | "proxycommand" | "include" => {
                current.blocked = true;
                current.unsupported.push((line, directive_name.clone()));
                current.warnings.push(SshConfigWarning {
                    line,
                    message: format!(
                        "{directive_name} 暂不支持；该 Host 已停用，避免按错误路径直连。"
                    ),
                });
            }
            _ => {
                if !current
                    .unsupported
                    .iter()
                    .any(|(_, name)| name.eq_ignore_ascii_case(&directive_name))
                {
                    current.unsupported.push((line, directive_name.clone()));
                }
                if is_blocking_directive(directive) {
                    current.blocked = true;
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: format!(
                            "{directive_name} 会改变连接语义且暂不支持；该 Host 已停用。"
                        ),
                    });
                } else {
                    current.warnings.push(SshConfigWarning {
                        line,
                        message: format!("{directive_name} 暂不支持，已忽略；该 Host 仍可导入。"),
                    });
                }
            }
        }
    }

    fn finish_current(&mut self) {
        let Some(block) = self.current.take() else {
            return;
        };
        self.warnings.extend(block.warnings.iter().cloned());
        if block.wildcard {
            self.warning(
                block.declaration_line,
                "通配 Host 已忽略；不会猜测其匹配目标或将其规则套用到导入项。",
            );
            let affecting_directives = wildcard_affecting_directives(&block);
            if !affecting_directives.is_empty() {
                self.block_globally(
                    block.declaration_line,
                    format!(
                        "通配 Host 包含影响目标或认证语义的 {}；无法安全判断其继承范围，全部明确 Host 已停用导入。",
                        affecting_directives.join("、")
                    ),
                );
            }
            if !block.unsupported.is_empty() {
                let names = block
                    .unsupported
                    .iter()
                    .map(|(_, name)| name.as_str())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join("、");
                self.warning(
                    block.declaration_line,
                    format!(
                        "通配 Host 包含 {names}；这些连接语义未展开，导入前请确认目标不依赖它们。"
                    ),
                );
            }
            return;
        }
        if block.discard || block.invalid || block.aliases.is_empty() {
            return;
        }
        let Some(username) = block.username else {
            self.warning(
                block.declaration_line,
                format!(
                    "Host {} 缺少 User，已跳过；Harbor 不猜测登录用户。",
                    block.aliases.join(" / ")
                ),
            );
            return;
        };

        let unsupported_directives = block
            .unsupported
            .iter()
            .map(|(_, directive)| directive.clone())
            .collect::<Vec<_>>();
        for alias in block.aliases {
            let host = block
                .host_name
                .as_deref()
                .unwrap_or(alias.as_str())
                .to_owned();
            let host = match normalized_import_host(&host) {
                Ok(host) => host,
                Err(()) => {
                    self.warning(
                        block.declaration_line,
                        format!("Host {alias} 的 HostName 无法作为连接主机导入，已跳过。"),
                    );
                    continue;
                }
            };
            self.entries.push(SshConfigEntry {
                alias,
                host,
                port: block.port.unwrap_or(22),
                username: username.clone(),
                identity_file: block.identity_file.clone(),
                unsupported_directives: unsupported_directives.clone(),
                warnings: block.warnings.clone(),
                importable: !block.blocked,
                trusted_host_key: false,
                private_key_copied: false,
            });
        }
    }
}

fn leading_directive(line: &str) -> Option<&str> {
    let directive = line
        .trim_start()
        .split(|character: char| character.is_whitespace() || character == '=')
        .next()?;
    (!directive.is_empty()).then_some(directive)
}

fn tokenize_line(line: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;

    for character in line.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            started = true;
            continue;
        }
        if character == '\\' {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
            }
            started = true;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            started = true;
            continue;
        }
        if character == '#' && !started {
            break;
        }
        if character.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut current));
                started = false;
            }
            continue;
        }
        current.push(character);
        started = true;
    }

    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(current);
    }
    Some(tokens)
}

fn normalized_import_host(value: &str) -> Result<String, ()> {
    if value.contains('%') || value.contains(['*', '?']) {
        return Err(());
    }
    Host::try_from(value)
        .map(|host| host.as_str().to_owned())
        .map_err(|_| ())
}

fn valid_alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.chars().any(char::is_control)
        && !value.chars().any(char::is_whitespace)
        && !value.contains('%')
}

fn valid_username(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.chars().any(char::is_control)
        && !value.chars().any(char::is_whitespace)
}

fn is_pattern(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '*' | '?' | '!' | '[' | ']'))
}

fn is_blocking_directive(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "canonicalizehostname"
            | "canonicaldomains"
            | "canonicalizepermittedcnames"
            | "hostkeyalias"
            | "localcommand"
            | "knownhostscommand"
            | "remotecommand"
    )
}

fn directive_affects_import(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "hostname" | "user" | "port" | "proxyjump" | "proxycommand" | "include"
    ) || is_blocking_directive(value)
}

fn wildcard_affecting_directives(block: &HostBlock) -> Vec<String> {
    let mut directives = std::collections::BTreeSet::new();
    if block.host_name.is_some() {
        directives.insert("HostName".to_owned());
    }
    if block.username.is_some() {
        directives.insert("User".to_owned());
    }
    if block.port.is_some() {
        directives.insert("Port".to_owned());
    }
    for (_, directive) in &block.unsupported {
        if directive_affects_import(directive) {
            directives.insert(directive.clone());
        }
    }

    directives.into_iter().collect()
}

fn canonical_directive(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "proxycommand" => "ProxyCommand".to_owned(),
        "proxyjump" => "ProxyJump".to_owned(),
        "hostname" => "HostName".to_owned(),
        "user" => "User".to_owned(),
        "port" => "Port".to_owned(),
        "identityfile" => "IdentityFile".to_owned(),
        "include" => "Include".to_owned(),
        "match" => "Match".to_owned(),
        _ => value.to_owned(),
    }
}

fn validate_atom(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
