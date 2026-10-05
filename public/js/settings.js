/* settings.js — split from public/app.js (app.js line 1921-2150). */
import { escapeHtml } from './markdown.js';
import { signOut } from './auth.js';
import { $, footerInfo, footerModel, input, modelSelect, setBase, setConnect, setKey, setMessage, setProvider, settingsStatus, state } from './state.js';

/* ================= Models & provider settings ================= */

export let appSettings = { provider: 'ollama', baseUrl: '', apiKeySet: false, providers: [] };

export async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) appSettings = await r.json();
  } catch { /* keep defaults */ }
  if (!Array.isArray(appSettings.providers) || !appSettings.providers.length) {
    appSettings.providers = [
      { id: 'ollama', label: 'Local (Ollama)', needsKey: false, defaultBaseUrl: '' },
    ];
  }
}

export function providerMeta(id) {
  return (
    appSettings.providers.find((p) => p.id === id) || {
      id,
      label: id,
      needsKey: true,
      defaultBaseUrl: '',
    }
  );
}

export function renderSettingsForm() {
  setProvider.innerHTML = appSettings.providers
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === appSettings.provider ? 'selected' : ''}>${escapeHtml(
          p.label
        )}</option>`
    )
    .join('');
  const activeMeta = providerMeta(appSettings.provider);
  setBase.value = appSettings.baseUrl || activeMeta.defaultBaseUrl || '';
  delete setBase.dataset.touched;
  syncProviderFields();
  renderAccount();
}

/*
 * The account menu under the form. Identity arrives on /api/settings — the one
 * request the boot already makes — so the panel never has to fetch anything to
 * know whose account this is or whether the Admin link should exist. Missing
 * values simply leave the link hidden: an unknown role is treated as "not an
 * admin", which is the only safe default.
 */
function renderAccount() {
  const who = $('set-who');
  if (who) who.textContent = appSettings.email || appSettings.name || '';
  const admin = $('set-admin');
  if (admin) admin.hidden = appSettings.role !== 'admin';
}

/* Wired once at module load; the button lives in the static markup. */
const signOutBtn = $('set-signout');
if (signOutBtn) signOutBtn.addEventListener('click', () => signOut());

export function syncProviderFields() {
  const meta = providerMeta(setProvider.value);
  const needsKey = meta.needsKey !== false;
  const isAuto = meta.kind === 'auto';
  $('set-key-row').style.display = needsKey ? '' : 'none';
  const baseRow = $('set-base-row');
  if (baseRow) baseRow.style.display = isAuto ? 'none' : '';
  setKey.value = '';
  const sameProvider = setProvider.value === appSettings.provider;
  setKey.placeholder = !needsKey
    ? 'No key needed'
    : sameProvider && appSettings.apiKeySet
      ? '•••••• saved — type to replace'
      : 'sk-…';
  if (isAuto) {
    setBase.value = '';
    delete setBase.dataset.touched;
  } else if (setBase.dataset.touched !== '1') {
    // Pick the provider's base URL automatically (editable if overridden).
    setBase.value = sameProvider
      ? appSettings.baseUrl || meta.defaultBaseUrl || ''
      : meta.defaultBaseUrl || '';
    setBase.placeholder = meta.defaultBaseUrl || 'https://…';
  }
  setMessage.textContent = '';
  setMessage.className = 'set-message';
  settingsStatus.textContent = '';
}

setProvider.addEventListener('change', () => {
  delete setBase.dataset.touched;
  syncProviderFields();
});
setBase.addEventListener('input', () => {
  setBase.dataset.touched = '1';
});

/* Save settings, then verify by listing the provider's models. */
export async function connectProvider() {
  const provider = setProvider.value;
  setConnect.disabled = true;
  setMessage.className = 'set-message working';
  setMessage.textContent = 'Connecting…';
  try {
    const body = { provider, baseUrl: setBase.value.trim() };
    const key = setKey.value.trim();
    if (key) body.apiKey = key;
    const r = await fetch('/api/settings/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Connection failed');

    appSettings = { ...d };
    delete appSettings.models; // settingsView only — models go to the dropdown
    delete setBase.dataset.touched;
    state.autoRoute = null; // re-routing from scratch after a settings change

    applyModels(d.models || []);
    setMessage.className = 'set-message ok';
    if (d.autoSources && d.autoSources.length) {
      const names = d.autoSources.map((x) => x.label.replace(/\s*\(.*\)\s*/, '')).join(', ');
      setMessage.textContent = `✓ Auto ready — ${d.autoSources.length} source(s): ${names}`;
    } else {
      setMessage.textContent = `✓ Connected — ${(d.models || []).length} model(s) available`;
    }
    settingsStatus.textContent = '✓';
    updateFooterModel();
  } catch (e) {
    setMessage.className = 'set-message err';
    setMessage.textContent = '✗ ' + (e.message || 'Connection failed');
    settingsStatus.textContent = '✗';
  } finally {
    setConnect.disabled = false;
  }
}
setConnect.addEventListener('click', connectProvider);

/* Left-sidebar footer: which provider + model is active. */
export function updateFooterModel() {
  if (footerModel) {
    const meta = providerMeta(appSettings.provider);
    const label = meta.label;
    if (meta.kind === 'auto') {
      const r = state.autoRoute;
      footerModel.textContent = r
        ? `Auto · ${r.label} · ${r.model}`
        : 'Auto · picks a working model per message';
      footerModel.title = r
        ? `Auto routing\nServing now: ${r.label}\nModel: ${r.model}` +
            (r.info && r.info.context ? `\nContext: ${r.info.context}` : '')
        : `${label}\nSend a message — the server probes for a source that answers.`;
    } else {
      footerModel.textContent = `${label} · ${state.model}`;
      footerModel.title = `Provider: ${label}\nModel: ${state.model}`;
    }
  }
  updateFooterInfo();
}

/* Info line above ⚙ Settings: the active model's context window and usage
 * limits — combined across sources when Auto is selected. */
export function updateFooterInfo() {
  if (!footerInfo) return;
  const info = state.modelInfo;
  if (!info || !info.text) {
    footerInfo.hidden = true;
    footerInfo.textContent = '';
    footerInfo.removeAttribute('title');
    return;
  }
  footerInfo.hidden = false;
  footerInfo.textContent = info.text;
  footerInfo.title = info.title || info.text;
}

export async function loadModelInfo() {
  try {
    const r = await fetch(
      `/api/model-info?provider=${encodeURIComponent(appSettings.provider)}` +
        `&model=${encodeURIComponent(state.model)}`
    );
    if (r.ok) state.modelInfo = await r.json();
  } catch { /* keep the previous info */ }
  updateFooterInfo();
}

export function applyModels(models) {
  if (!models.length) throw new Error('the provider returned no models');
  const autoMode =
    appSettings.provider === 'auto' || (models.length === 1 && models[0].name === 'auto');
  if (autoMode) {
    // Auto: the server picks the source/model per message.
    state.model = 'auto';
    modelSelect.innerHTML = '<option value="auto">Auto — server picks a model</option>';
    modelSelect.disabled = true;
    updateModelWrapTitle();
    updateFooterModel();
    loadModelInfo();
    return;
  }
  modelSelect.disabled = false;
  if (!models.some((m) => m.name === state.model)) state.model = models[0].name;
  modelSelect.innerHTML = models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.name)}" ${
          m.name === state.model ? 'selected' : ''
        }>${escapeHtml(m.name)}</option>`
    )
    .join('');
  updateModelWrapTitle();
  updateFooterModel();
  loadModelInfo();
}

export async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'model list failed');
    applyModels(data.models || []);
  } catch {
    modelSelect.disabled = false;
    modelSelect.innerHTML = `<option value="${escapeHtml(state.model)}">${escapeHtml(
      state.model
    )}</option>`;
    loadModelInfo();
  }
  updateModelWrapTitle();
  updateFooterModel();
}

modelSelect.addEventListener('change', () => {
  state.model = modelSelect.value;
  updateModelWrapTitle();
  updateFooterModel();
  loadModelInfo();
});

/* Tooltip showing the current model (useful when the select is icon-only). */
export function updateModelWrapTitle() {
  const wrap = $('model-wrap');
  if (wrap) wrap.title = `Model: ${state.model}`;
}
