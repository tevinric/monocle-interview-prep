import multiprocessing

# Backend listens on a fixed internal port; the host-side port is mapped in
# docker-compose.yml via @@PREFIX@@_BACKEND_PORT.
bind = '0.0.0.0:5000'
backlog = 2048

workers = multiprocessing.cpu_count() * 2 + 1
worker_class = 'sync'
timeout = 120
keepalive = 2

max_requests = 1000
max_requests_jitter = 50

accesslog = '-'
errorlog = '-'
loglevel = 'info'

proc_name = '@@SLUG@@_backend'
