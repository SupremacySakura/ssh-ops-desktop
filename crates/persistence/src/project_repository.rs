use std::str::FromStr;

use opspilot_domain::{
    CoreError, CoreErrorCode, DeployStrategy, Id, ProjectInput, ProjectRoot, ProjectSummary,
    RuntimeType,
};

use crate::Database;

#[derive(Clone, Debug)]
pub struct ProjectRepository {
    database: Database,
}

impl ProjectRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn create(&self, input: ProjectInput) -> Result<ProjectSummary, CoreError> {
        let project = ProjectSummary {
            id: Id::new(),
            server_id: input.server_id,
            name: input.name,
            root_path: input.root_path,
            repository_url: input.repository_url,
            runtime: input.runtime,
            deploy_strategy: input.deploy_strategy,
        };
        sqlx::query(
            "INSERT INTO projects (
                id, server_id, name, root_path, repository_url, runtime_type, deploy_strategy,
                created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(project.id.to_string())
        .bind(project.server_id.to_string())
        .bind(&project.name)
        .bind(project.root_path.as_str())
        .bind(&project.repository_url)
        .bind(runtime_string(project.runtime))
        .bind(strategy_string(project.deploy_strategy))
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("create project", error))?;
        Ok(project)
    }

    pub async fn get(&self, id: Id) -> Result<ProjectSummary, CoreError> {
        let row = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, server_id, name, root_path, repository_url, runtime_type,
                    deploy_strategy FROM projects WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("get project", error))?
        .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "project was not found", false))?;
        row.into_summary()
    }

    pub async fn list_for_server(&self, server_id: Id) -> Result<Vec<ProjectSummary>, CoreError> {
        let rows = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, server_id, name, root_path, repository_url, runtime_type,
                    deploy_strategy FROM projects WHERE server_id = ? ORDER BY lower(name), id",
        )
        .bind(server_id.to_string())
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("list projects", error))?;
        rows.into_iter().map(ProjectRow::into_summary).collect()
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    server_id: String,
    name: String,
    root_path: String,
    repository_url: Option<String>,
    runtime_type: String,
    deploy_strategy: String,
}

impl ProjectRow {
    fn into_summary(self) -> Result<ProjectSummary, CoreError> {
        Ok(ProjectSummary {
            id: parse_id(&self.id)?,
            server_id: parse_id(&self.server_id)?,
            name: self.name,
            root_path: ProjectRoot::try_new(&self.root_path)?,
            repository_url: self.repository_url,
            runtime: parse_runtime(&self.runtime_type)?,
            deploy_strategy: parse_strategy(&self.deploy_strategy)?,
        })
    }
}

fn runtime_string(value: RuntimeType) -> &'static str {
    match value {
        RuntimeType::DockerCompose => "docker_compose",
        RuntimeType::StaticSite => "static_site",
        RuntimeType::NodeJs => "node_js",
        RuntimeType::Go => "go",
        RuntimeType::Python => "python",
        RuntimeType::Generic => "generic",
    }
}

fn parse_runtime(value: &str) -> Result<RuntimeType, CoreError> {
    match value {
        "docker_compose" => Ok(RuntimeType::DockerCompose),
        "static_site" => Ok(RuntimeType::StaticSite),
        "node_js" => Ok(RuntimeType::NodeJs),
        "go" => Ok(RuntimeType::Go),
        "python" => Ok(RuntimeType::Python),
        "generic" => Ok(RuntimeType::Generic),
        _ => Err(invariant("persisted project runtime is invalid")),
    }
}

fn strategy_string(value: DeployStrategy) -> &'static str {
    match value {
        DeployStrategy::InPlace => "in_place",
        DeployStrategy::ReleaseSymlink => "release_symlink",
        DeployStrategy::DockerCompose => "docker_compose",
        DeployStrategy::StaticAtomic => "static_atomic",
    }
}

fn parse_strategy(value: &str) -> Result<DeployStrategy, CoreError> {
    match value {
        "in_place" => Ok(DeployStrategy::InPlace),
        "release_symlink" => Ok(DeployStrategy::ReleaseSymlink),
        "docker_compose" => Ok(DeployStrategy::DockerCompose),
        "static_atomic" => Ok(DeployStrategy::StaticAtomic),
        _ => Err(invariant("persisted deploy strategy is invalid")),
    }
}

fn parse_id(value: &str) -> Result<Id, CoreError> {
    Id::from_str(value).map_err(|_| invariant("persisted project identifier is invalid"))
}

fn invariant(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Internal, message, false)
}

fn persistence_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
