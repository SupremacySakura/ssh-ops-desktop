import { useEffect, useState } from 'react';
import { ModelProfileInputSchema, type ModelProfileSummary } from '@opspilot/contracts';

import type { CoreClient } from '../../api/core';
import { PageHeader, Panel, SectionHeader } from '../../app/ui/layout';

export function ModelSettings({ core }: { core: CoreClient }) {
  const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (core.modelProfiles?.() ?? Promise.resolve([]))
      .then((items) => { if (active) setProfiles(items); })
      .catch(() => { if (active) setMessage('无法读取模型配置'); });
    return () => { active = false; };
  }, [core]);

  const save = async () => {
    setMessage('');
    const parsed = ModelProfileInputSchema.safeParse({
      name,
      provider: 'openai-compatible',
      baseUrl,
      model,
      timeoutMs: 30_000,
      ...(apiKey ? { apiKey } : {}),
      isDefault: profiles.length === 0,
    });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? '配置无效');
      return;
    }
    if (!core.saveModelProfile) {
      setMessage('当前 Core 不支持保存模型配置');
      return;
    }
    setBusy(true);
    try {
      const saved = await core.saveModelProfile(parsed.data);
      setProfiles((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setApiKey('');
      setMessage('模型配置已安全保存');
    } catch {
      setMessage('模型配置保存失败');
    } finally {
      setBusy(false);
    }
  };

  const test = async (profile: ModelProfileSummary) => {
    if (!core.testModelProfile) return;
    setMessage('正在测试模型连接…');
    try {
      await core.testModelProfile(profile.id);
      setMessage('模型连接成功');
    } catch {
      setMessage('模型连接失败，请检查地址、模型和凭据');
    }
  };

  return <div className="settings-layout">
    <Panel aria-label="模型配置" className="model-form">
      <SectionHeader actions={<span className="provider-badge">OpenAI-compatible</span>} description="请求只发送到明确配置的服务地址" title="模型配置" />
      <div className="credential-notice"><strong>凭据隔离</strong><p>API Key 保存进系统凭据库，保存成功后立即从页面状态清除。</p></div>
      <label>配置名称<input aria-label="配置名称" maxLength={128} onChange={(event) => setName(event.target.value)} value={name} /></label>
      <label>Base URL<input aria-label="Base URL" inputMode="url" onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://models.example.com/v1" value={baseUrl} /></label>
      <label>Model<input aria-label="Model" maxLength={256} onChange={(event) => setModel(event.target.value)} value={model} /></label>
      <label>API Key<input aria-label="API Key" autoComplete="new-password" onChange={(event) => setApiKey(event.target.value)} type="password" value={apiKey} /></label>
      <button className="primary" disabled={busy} onClick={() => void save()} type="button">保存模型配置</button>
      {message ? <p className="form-message" role="status">{message}</p> : null}
    </Panel>
    <Panel aria-label="已保存模型" className="saved-models-panel">
      <SectionHeader count={profiles.length} description="仅显示非敏感配置摘要" title="已保存模型" />
      {profiles.length === 0 ? <div className="conversation-empty">尚未配置模型</div> : <ul className="profile-list">{profiles.map((profile) => <li key={profile.id}>
        <div><strong>{profile.name}</strong><small>{profile.baseUrl} · {profile.model}</small></div>
        <span className="status-badge"><i />{profile.hasApiKey ? '已配置 API Key' : '无需 API Key'}</span>
        <button onClick={() => void test(profile)} type="button">测试连接</button>
      </li>)}</ul>}
    </Panel>
  </div>;
}

export function SettingsPage({ core }: { core: CoreClient }) {
  return <div className="page-stack">
    <PageHeader description="模型凭据存入系统凭据库，页面只显示是否已配置。" eyebrow="Preferences" title="设置" />
    <ModelSettings core={core} />
  </div>;
}
