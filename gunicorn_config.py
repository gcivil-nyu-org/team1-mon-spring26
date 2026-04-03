import multiprocessing

# Worker settings
worker_class = 'gevent'
workers = multiprocessing.cpu_count() * 2 + 1
timeout = 180  # High timeout for SSE persistent connections
keepalive = 2  # between nginx and gunicorn

def post_fork(server, worker):
    # Required if using PostgreSQL with gevent
    try:
        from psycogreen.gevent import patch_psycopg
        patch_psycopg()
        server.log.info("Patched psycopg2 for gevent")
    except ImportError:
        pass
