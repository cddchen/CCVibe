const root = document.documentElement;
const body = document.body;
const toast = document.querySelector('#toast');

const defaults = {
  alpha: 72,
  blur: 28,
  saturation: 150,
  highlight: 78,
  shadow: 18,
};

const controls = {
  alpha: document.querySelector('#glass-alpha'),
  blur: document.querySelector('#glass-blur'),
  saturation: document.querySelector('#glass-saturation'),
  highlight: document.querySelector('#glass-highlight'),
  shadow: document.querySelector('#glass-shadow'),
};

const showToast = (message) => {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
};

const applyControls = () => {
  const values = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, Number(input.value)]));
  root.style.setProperty('--glass-alpha', (values.alpha / 100).toFixed(2));
  root.style.setProperty('--glass-blur', `${values.blur}px`);
  root.style.setProperty('--glass-saturation', `${values.saturation}%`);
  root.style.setProperty('--glass-highlight', (values.highlight / 100).toFixed(2));
  root.style.setProperty('--glass-shadow', String(values.shadow));

  document.querySelector('#alpha-output').textContent = `${values.alpha}%`;
  document.querySelector('#blur-output').textContent = `${values.blur}px`;
  document.querySelector('#saturation-output').textContent = `${values.saturation}%`;
  document.querySelector('#highlight-output').textContent = `${values.highlight}%`;
  document.querySelector('#shadow-output').textContent = String(values.shadow);
  document.querySelector('#token-blur').textContent = `${values.blur}px`;
  document.querySelector('#token-alpha').textContent = (values.alpha / 100).toFixed(2).replace(/^0/, '');
};

Object.values(controls).forEach((control) => control.addEventListener('input', applyControls));

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    body.dataset.view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('is-active', item === button));
  });
});

document.querySelectorAll('[data-open-chat]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector('[data-view="chat"]').click());
});

document.querySelectorAll('[data-open-home]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector('[data-view="home"]').click());
});

document.querySelector('#edit-toggle').addEventListener('click', (event) => {
  const active = event.currentTarget.getAttribute('aria-pressed') !== 'true';
  event.currentTarget.setAttribute('aria-pressed', String(active));
  event.currentTarget.classList.toggle('is-active', active);
  document.querySelectorAll('[data-editable]').forEach((node) => node.setAttribute('contenteditable', String(active)));
  showToast(active ? '已开启文案编辑' : '已退出文案编辑');
});

const thinkingDetail = document.querySelector('#thinking-detail');
const thinkingToggle = document.querySelector('#thinking-toggle');
const thinkingControl = document.querySelector('#thinking-control');
const setThinking = (open) => {
  thinkingDetail.classList.toggle('is-open', open);
  thinkingToggle.setAttribute('aria-expanded', String(open));
  thinkingControl.checked = open;
};
thinkingToggle.addEventListener('click', () => setThinking(thinkingToggle.getAttribute('aria-expanded') !== 'true'));
thinkingControl.addEventListener('change', () => setThinking(thinkingControl.checked));

const permissionSheet = document.querySelector('#permission-sheet');
document.querySelector('#permission-toggle').addEventListener('change', (event) => permissionSheet.classList.toggle('is-hidden', !event.currentTarget.checked));

document.querySelector('#reset-controls').addEventListener('click', () => {
  Object.entries(defaults).forEach(([key, value]) => { controls[key].value = value; });
  applyControls();
  showToast('材质参数已重置');
});

document.querySelector('#copy-tokens').addEventListener('click', async () => {
  const tokens = `--glass-alpha: ${(Number(controls.alpha.value) / 100).toFixed(2)};\n--glass-blur: ${controls.blur.value}px;\n--glass-saturation: ${controls.saturation.value}%;\n--glass-highlight: ${(Number(controls.highlight.value) / 100).toFixed(2)};\n--glass-shadow: ${controls.shadow.value};`;
  try {
    await navigator.clipboard.writeText(tokens);
    showToast('设计令牌已复制');
  } catch {
    showToast('无法访问剪贴板，请从 styles.css 读取令牌');
  }
});

document.querySelector('.new-chat-button').addEventListener('click', () => showToast('当前已是新对话'));
document.querySelector('.allow-button').addEventListener('click', () => {
  permissionSheet.classList.add('is-hidden');
  document.querySelector('#permission-toggle').checked = false;
  showToast('已允许执行一次');
});
document.querySelector('.deny-button').addEventListener('click', () => {
  permissionSheet.classList.add('is-hidden');
  document.querySelector('#permission-toggle').checked = false;
  showToast('已拒绝工具调用');
});

applyControls();
