#!/bin/sh
# Renderiza o template do nginx com as variáveis de ambiente antes do nginx subir.
# Precisa existir porque plataformas que iniciam o container por startCommand pulam
# o docker-entrypoint.sh da imagem oficial (e com ele o envsubst de templates).
#
# Dois modos, escolhidos pela variável USE_PUBLIC_UPSTREAM:
#   0 (padrão)  — proxy http para ${BACKEND}:${PORT}   (docker compose / rede interna)
#   1           — proxy https para ${BACKEND}          (domínio público da API;
#                 usado quando não há rede privada compartilhada entre os containers)
set -e

if [ -f /etc/nginx/templates/default.conf.template ]; then
  if [ "${USE_PUBLIC_UPSTREAM:-0}" = "1" ]; then
    PROXY_CONF=$(cat <<EOF
        proxy_pass https://${BACKEND};
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_set_header Host ${BACKEND};
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
EOF
)
  else
    PROXY_CONF=$(cat <<EOF
        proxy_pass http://${BACKEND}:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
EOF
)
  fi
  export PROXY_CONF
  for f in /etc/nginx/templates/*.template; do
    dest="/etc/nginx/conf.d/$(basename "$f" .template)"
    envsubst 'BACKEND PORT NGINX_PORT PROXY_CONF' < "$f" > "$dest"
    echo "[nginx-start] rendered $f -> $dest"
  done
else
  echo "[nginx-start] AVISO: template ausente — usando conf existente"
fi
exec /docker-entrypoint.sh nginx -g 'daemon off;'
