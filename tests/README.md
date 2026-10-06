# Локальные браузерные проверки

Запуск из корня проекта:

```powershell
node --test tests/background.test.cjs tests/hide-relative.test.cjs
```

Нужны Node.js 20 или новее, Playwright и Chromium. Тест автоматически использует установленный
модуль `playwright` (включая `NODE_PATH`) либо Playwright из runtime приложения
Codex. В Windows при наличии скачанного Chromium Headless Shell используется он.
Пути можно явно задать переменными окружения `VIEWBLOCK_PLAYWRIGHT_MODULE` и
`VIEWBLOCK_CHROMIUM`; сам тест ничего не устанавливает и не скачивает.

Если в `PATH` находится более старый Node.js, используйте полный путь к новой
версии. Например, в Windows с runtime приложения Codex:

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test tests/background.test.cjs tests/hide-relative.test.cjs
```

Проверяются настоящий DOM, геометрия CSS Grid, применение CSS из `content.js`,
изменения идентификаторов, замена разметки, сохранение профилей и повторное
применение скрытия. Страницы подаются через перехват локального URL в браузере:
сервер и внешние сайты не нужны. Chrome Extension API заменены тестовой моделью;
это не проверка установленного расширения и жизненного цикла его service worker.
Код `background.js` отдельно запускается в Node VM: проверяются протокол,
сохранение/переключение режимов, перезапуск worker и параллельные записи.
