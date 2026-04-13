web: gunicorn django_map.wsgi:application -c gunicorn_config.py
asgi: uvicorn django_map.asgi:application --host 127.0.0.1 --port 8001