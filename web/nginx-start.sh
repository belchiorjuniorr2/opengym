#!/bin/sh
# Garante que o template do nginx seja renderizado com as variáveis de ambiente
# (BACKEND, PORT, NGINX_PORT) antes do nginx subir — mesmo quando o container é
# iniciado por um startCommand da plataforma, que pula o docker-entrypoint.sh
# padrão da imagem oficial (e com ele o passo 20-envsubst-on-templates.sh).
# Os ENVs têm defaults no Dockerfile (80/api/3000), então sempre existem.
if [ -f /etc/nginx/templates/default.conf.template ]; then
  for f in /etc/nginx/templates/*.template; do
    dest="/etc/nginx/conf.d/$(basename "$f" .template)"
    envsubst 'BACKEND PORT NGINX_PORT' < "$f" > "$dest"
    echo "[nginx-start] rendered $f -> $dest"
  done
else
  echo "[nginx-start] AVISO: template ausente — usando conf existente"
fi
exec /docker-entrypoint.sh nginx -g 'daemon off;'
