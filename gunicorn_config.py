import multiprocessing

# Worker settings
worker_class = "gevent"
workers = multiprocessing.cpu_count() * 2 + 1
timeout = 60
keepalive = 2  # between nginx and gunicorn

max_requests = 1000  # Restart workers after 1000 requests, frees memory
max_requests_jitter = 50  # Add randomness to worker restarts (not all at once)
