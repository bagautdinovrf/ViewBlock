'use strict';
let clicks = 0;
document.getElementById('counter').addEventListener('click', event => { event.currentTarget.textContent = `Проверить кнопку: ${++clicks}`; });
document.getElementById('refresh').addEventListener('click', () => {
  const row = document.createElement('div'); row.className = 'mail-row'; row.textContent = 'Новое письмо · обновлено без перезагрузки';
  document.getElementById('messages').append(row);
});
document.getElementById('compose').addEventListener('click', () => document.getElementById('compose-dialog').showModal());
