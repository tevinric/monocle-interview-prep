import multiprocessing

# Backend listens on a fixed internal port; the host-side port is mapped in
# docker-compose.yml via LENS_BACKEND_PORT.
bind = '0.0.0.0:5000'
backlog = 2048

# gthread, not sync: /api/chat holds a connection open for the whole agent run
# (Server-Sent Events). A sync worker would be pinned for that long.
workers = min(multiprocessing.cpu_count(), 4)
worker_class = 'gthread'
threads = 8
# Above the worst-case agent run: 3 tool iterations x LLM timeout + one retry each.
timeout = 300
keepalive = 5

max_requests = 1000
max_requests_jitter = 50

accesslog = '-'
errorlog = '-'
loglevel = 'info'

proc_name = 'lens_backend'
