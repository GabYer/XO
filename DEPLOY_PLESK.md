# XO Classic Online on Plesk

## Что важно

Этот проект теперь работает на Node.js и не требует Python.

## Что загрузить на сервер

Загружайте весь проект целиком:

- `server.js`
- `package.json`
- папку `public`
- `runtime-config.js` внутри `public`

## Настройка в Plesk

1. Откройте `Node.js` в панели сайта.
2. Выберите `Application Root` на папку проекта.
3. Укажите `Application Startup File`: `server.js`.
4. Нажмите `Enable Node.js`.
5. Нажмите `Restart App`.

## Если сайт и API на одном домене

Ничего дополнительно указывать не нужно.

## Если frontend и backend на разных доменах

В `public/runtime-config.js` укажите:

```js
window.XO_RUNTIME = {
  baseUrl: "https://your-frontend-domain",
  apiBaseUrl: "https://your-api-domain"
};
```

И задайте на сервере переменную окружения:

```text
XO_CORS_ORIGIN=https://your-frontend-domain
```

## Локальный запуск

```bash
node server.js
```

## Notes

- This project does not require Python.
- This project does not have external npm dependencies, so `npm install` is optional.
- In Plesk, set the startup file to `server.js` and restart the Node.js app after upload.
