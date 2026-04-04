import multiprocessing

# Worker settings
worker_class = "gevent"
workers = multiprocessing.cpu_count() * 2 + 1
timeout = 60
keepalive = 2  # between nginx and gunicorn
