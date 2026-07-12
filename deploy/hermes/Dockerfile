FROM nousresearch/hermes-agent:latest

COPY --chmod=0755 deploy/hermes/start.sh /usr/local/bin/edge-desk-hermes
COPY --chmod=0644 deploy/hermes/config.yaml /opt/edge-desk/config.yaml

# The base image keeps /init as PID 1. Its command wrapper recognizes this
# executable, drops privileges to the hermes user, and retains s6 supervision.
CMD ["edge-desk-hermes"]
