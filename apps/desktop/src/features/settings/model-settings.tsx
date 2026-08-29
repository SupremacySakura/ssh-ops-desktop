import { useEffect, useState } from 'react';
import { ModelProfileInputSchema, type ModelProfileSummary } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { Select } from '../../app/ui/select';

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;

type ThemeOption = (typeof THEME_OPTIONS)[number]['value'];

export function SettingsPage({ core }: { core: CoreClient }) {
  const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [themeOption, setThemeOption] = useState<ThemeOption>('system');
  const [strictHostKey, setStrictHostKey] = useState(true);
  const [autoRollback, setAutoRollback] = useState(true);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [sidebarMotion, setSidebarMotion] = useState(true);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let active = true;
    void (core.modelProfiles?.() ?? Promise.resolve([]))
      .then((items) => {
        if (!active) return;
        setProfiles(items);
        const preferred = items.find((item) => item.isDefault) ?? items[0];
        if (preferred) setSelectedModel(preferred.model);
      })
      .catch(() => { if (active) setMessage('无法读取模型配置'); });
    return () => { active = false; };
  }, [core]);

  const save = async () => {
    setMessage('');
    const defaultProfile = profiles.find((item) => item.isDefault) ?? profiles[0];
    const parsed = ModelProfileInputSchema.safeParse({
      name: defaultProfile?.name ?? '默认模型',
      provider: 'openai-compatible',
      baseUrl: defaultProfile?.baseUrl ?? 'https://models.example.com/v1',
      model: selectedModel,
      timeoutMs: defaultProfile?.timeoutMs ?? 30_000,
      ...(apiKey ? { apiKey } : {}),
      isDefault: true,
    });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? '配置无效');
      return;
    }
    if (!core.saveModelProfile) {
      setMessage('当前 Core 不支持保存模型配置');
      return;
    }
    try {
      const saved = await core.saveModelProfile(parsed.data);
      setProfiles((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setApiKey('');
      setMessage('设置已保存');
    } catch {
      setMessage('模型配置保存失败');
    }
  };

  return <>
    <div className="page-header">
      <div>
        <h1>设置</h1>
        <p>模型、账户与系统偏好</p>
      </div>
      <div className="page-actions">
        <button className="btn btn-primary" onClick={() => void save()} type="button">保存更改</button>
      </div>
    </div>

    {message ? <div className="alert success-alert" role="status">{message}</div> : null}

    <div className="settings-section">
      <div className="card settings-group">
        <div className="card-header">
          <div>
            <h3 className="card-title">模型配置</h3>
            <div className="card-subtitle">选择 AI Agent 使用的推理模型</div>
          </div>
        </div>
        <div className="card-body">
          <div className="form-group">
            <label className="form-label">默认模型</label>
            <Select
              aria-label="默认模型"
              onChange={(value) => setSelectedModel(value)}
              options={profiles.map((profile) => ({ value: profile.model, label: `${profile.name} · ${profile.model}` }))}
              placeholder={profiles.length === 0 ? '尚未配置模型' : '请选择模型'}
              value={selectedModel}
            />
          </div>
          <div className="form-group mb-0">
            <label className="form-label">API Key</label>
            <input aria-label="API Key" autoComplete="new-password" className="input" onChange={(event) => setApiKey(event.target.value)} placeholder="sk-••••••••••••••••" type="password" value={apiKey} />
            <div className="form-hint">本地加密存储，不会上传到服务器</div>
          </div>
        </div>
      </div>

      <div className="card settings-group">
        <div className="card-header">
          <div>
            <h3 className="card-title">SSH 偏好</h3>
            <div className="card-subtitle">默认终端与连接行为</div>
          </div>
        </div>
        <div className="card-body">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">严格主机密钥检查</div>
              <div className="settings-row-desc">首次连接时验证主机指纹</div>
            </div>
            <div className={strictHostKey ? 'toggle active' : 'toggle'} onClick={() => setStrictHostKey((value) => !value)} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">任务失败后自动回滚</div>
              <div className="settings-row-desc">部署类任务失败时尝试恢复上一个版本</div>
            </div>
            <div className={autoRollback ? 'toggle active' : 'toggle'} onClick={() => setAutoRollback((value) => !value)} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">Agent 自动确认低风险命令</div>
              <div className="settings-row-desc">如 ls、cat、ps 等只读命令无需手动确认</div>
            </div>
            <div className={autoConfirm ? 'toggle active' : 'toggle'} onClick={() => setAutoConfirm((value) => !value)} />
          </div>
        </div>
      </div>

      <div className="card settings-group">
        <div className="card-header">
          <div>
            <h3 className="card-title">外观</h3>
            <div className="card-subtitle">界面显示与动画</div>
          </div>
        </div>
        <div className="card-body">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">外观模式</div>
              <div className="settings-row-desc">跟随系统，或手动切换浅色 / 深色主题</div>
            </div>
            <div className="tabs theme-segment" role="radiogroup" aria-label="外观模式">
              {THEME_OPTIONS.map((option) => (
                <button
                  aria-checked={themeOption === option.value}
                  className={themeOption === option.value ? 'tab active' : 'tab'}
                  data-theme-option={option.value}
                  key={option.value}
                  onClick={() => setThemeOption(option.value)}
                  role="radio"
                  type="button"
                >{option.label}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">侧边栏动画</div>
              <div className="settings-row-desc">展开/收起时使用弹簧动画</div>
            </div>
            <div className={sidebarMotion ? 'toggle active' : 'toggle'} onClick={() => setSidebarMotion((value) => !value)} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">减少透明度</div>
              <div className="settings-row-desc">禁用毛玻璃效果以提升可读性</div>
            </div>
            <div className={reduceTransparency ? 'toggle active' : 'toggle'} data-action="reduce-transparency" onClick={() => setReduceTransparency((value) => !value)} />
          </div>
        </div>
      </div>
    </div>
  </>;
}
