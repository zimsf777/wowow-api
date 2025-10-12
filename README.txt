Render deploy:
1) Создайте репозиторий на GitHub и загрузите файлы из этого архива.
2) На Render: New -> Web Service -> Connect Git repo.
3) Build: npm i, Start: node server/server.js.
4) Environment: RUNWAY_API_KEY = ваш ключ.
5) Получите адрес https://<app>.onrender.com и привяжите к api.wowow.ru через CNAME.
