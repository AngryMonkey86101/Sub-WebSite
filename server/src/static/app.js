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
