import multiprocessing

# Worker settings
worker_class = 'gevent'
workers = multiprocessing.cpu_count() * 2 + 1
timeout = 180  # High timeout for SSE persistent connections
keepalive = 2  # between nginx and gunicorn
