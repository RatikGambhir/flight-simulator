# Static host for the browser build of the simulator (deploy-web workflow).
# The workflow copies this file and the Caddyfile next to the built dist/ and
# uploads that folder to Railway, which builds this image.
FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY site/ /srv/
