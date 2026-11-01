// Кнопки «Скопировать» и подтверждение опасных действий. Без этого скрипта страницы тоже
// работают: ключ можно выделить и скопировать вручную, формы отправляются без вопроса.

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const field = document.getElementById(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(field.value);
  } catch {
    field.select();
    document.execCommand('copy');
  }
  const label = button.textContent;
  button.textContent = 'Скопировано';
  setTimeout(() => {
    button.textContent = label;
  }, 2000);
});

document.addEventListener('submit', (event) => {
  const question = event.target.dataset.confirm;
  if (question && !window.confirm(question)) event.preventDefault();
});

// Ярлык на экране «Домой». Chrome на Android сообщает событием beforeinstallprompt, что может
// показать окно установки; тогда кнопка открывает его. Иначе (iPhone, другие браузеры) кнопка
// раскрывает инструкцию. В портале, открытом с ярлыка, раздел не нужен.
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

document.addEventListener('click', async (event) => {
  if (!event.target.closest('[data-install]')) return;
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
    return;
  }
  const help = document.getElementById('install-help');
  help.open = true;
  help.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
  for (const section of document.querySelectorAll('[data-install-section]')) section.hidden = true;
}
