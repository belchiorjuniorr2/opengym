# Deploy: Supabase + Railway (ou Vercel)

Guia para colocar o Zé Treino no ar **sem servidor próprio**, com banco de dados
gerenciado no [Supabase](https://supabase.com) e aplicação no
[Railway](https://railway.app) — ou frontend na Vercel, se preferir.

```
Celular/Navegador ──HTTPS──▶ web  (nginx + app React)
                              └─ /api ──▶ api  (Node + WebAuthn)
                                            └─▶ Supabase (Postgres) ← usuários,
                                                passkeys, treinos, peso, auditoria
```

> **Por que Railway e não Vercel para a API?** A API é um processo de longa
> duração: guarda desafios WebAuthn em memória entre os passos do login, agenda
> os alertas do cronômetro de descanso e o lembrete de dia de treino com
> `setInterval`, e mantém a presença "treinando agora". Serverless (Lambda/Vercel
> Functions) zera memória e timers entre requisições — isso quebraria o login por
> passkey e as notificações. A **Vercel serve bem o frontend** (veja a Opção B);
> a API precisa ficar num serviço persistente como o Railway.

---

## 1. Supabase — banco de dados

1. Crie uma conta em [supabase.com](https://supabase.com) e um novo projeto
   (plano gratuito funciona; escolha a região mais próxima dos usuários).
2. Guarde a **senha do banco** definida na criação do projeto.
3. Em **Project Settings → Database → Connection string → URI**, copie a string.
   - Prefira o **Connection pooling** (porta `6543`, transacional) se usar o
     pooler Supavisor; a porta direta `5432` também funciona para a API.
4. A string fica parecida com:

   ```
   postgresql://postgres.abcdefgh:[SENHA]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
   ```

5. **Nada para criar à mão**: no primeiro boot a API cria as tabelas
   (`app_kv`, `user_state`, `audit_events`) automaticamente.

Essa URL será a variável `DATABASE_URL` da API.

## 2. Railway — api + web

O repositório já traz `api/railway.json` e `web/railway.json`, então o Railway
detecta tudo sozinho.

### 2.1 Serviço `api`

1. New Project → **Deploy from GitHub repo** (faça fork/push deste repositório).
2. No serviço criado, abra **Settings → Root Directory** e defina `api`.
3. Adicione as variáveis (aba **Variables**):

   | Variável        | Valor                                                        |
   |-----------------|--------------------------------------------------------------|
   | `DATABASE_URL`  | a connection string do Supabase (passo 1.4)                  |
   | `RP_ID`         | seu domínio sem protocolo, ex.: `gym.seudominio.com`         |
   | `ORIGIN`        | URL completa do site, ex.: `https://gym.seudominio.com`      |
   | `RP_NAME`       | `Zé Treino`                                                    |
   | `SESSION_DAYS`  | `90` (opcional)                                              |

   > `PORT` não precisa ser definida: o Railway injeta e a API já usa.

4. Aba **Settings → Networking → Generate Domain** para expor a porta. Marque a
   opção de domínio **interno** se quiser que só o `web` alcance a API — nesse
   caso anote o endereço `api.railway.internal` gerado pelo Railway.

### 2.2 Serviço `web`

1. No mesmo projeto, **+ New → GitHub Repo**, mesmo repositório.
2. **Root Directory**: `web`. O build multi-stage compila o frontend e sobe o nginx.
3. Variáveis (o nginx renderiza a configuração no boot):

   | Variável         | Valor                                                          |
   |------------------|----------------------------------------------------------------|
   | `BACKEND`        | domínio público da API (ex.: `api-production-xxxx.up.railway.app`) |
   | `USE_PUBLIC_UPSTREAM` | `1` (proxy https para o domínio acima)                    |
   | `NGINX_PORT`     | `80`                                                           |
   | `VITE_IMG_BASE`  | `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/` |
   | `VITE_GIF_BASE`  | `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/` |

   As duas últimas carregam as imagens/animações dos exercícios de um CDN, já
   que não há volume compartilhado como no docker compose. Elas são lidas em
   **tempo de build** (o Railway repassa variáveis como build args do Docker).

4. **Settings → Networking → Generate Domain** — esse é o endereço público do app.

> **Importante:** não defina `startCommand` para o `web` (nem no painel nem no
> `railway.json`). O container precisa iniciar pelo `docker-entrypoint.sh` da
> imagem oficial do nginx — é ele que renderiza o template de configuração. O
> repositório já traz o script `web/nginx-start.sh`, que garante essa renderização.

> **Sobre `USE_PUBLIC_UPSTREAM`:** por padrão (`0`, usado no docker compose) o
> nginx proxifica `/api` para `http://BACKEND:PORT` numa rede interna. No
> Railway, o DNS privado entre serviços pode não estar disponível para pares
> sem porta privada vinculada; nesse caso use o modo `1` apontando `BACKEND`
> para o domínio público da API (gerado em *Networking* do serviço `api`,
> target port `3000`). O tráfego sai pela borda TLS pública — ok para uma
> instância pessoal, e as passkeys continuam vinculadas só ao domínio do app.

### 2.3 Passkeys no domínio

Passkeys são vinculadas ao hostname exato e exigem HTTPS. Ao gerar o domínio no
Railway (ex.: `opengym-production.up.railway.app`), use-o nas variáveis:

```
RP_ID=opengym-production.up.railway.app
ORIGIN=https://opengym-production.up.railway.app
```

Com domínio próprio: aponte um CNAME para o Railway, adicione o domínio em
**Settings → Networking → Custom Domain** e use o seu domínio em `RP_ID`/`ORIGIN`.

> Mudou `RP_ID`/`ORIGIN` depois de criar perfis? As passkeys antigas ficam
> vinculadas ao hostname anterior — recrie os perfis ou mantenha o domínio.

## 3. Vercel (alternativa ao serviço web)

Dá para hospedar **só o frontend** na Vercel e deixar a API no Railway:

1. Importe o repositório na Vercel com **Root Directory = `frontend`**
   (framework Vite detectado automaticamente).
2. Adicione `frontend/vercel.json` (ou configure no painel) com o proxy que
   mantém tudo em **uma origem** — obrigatório para passkeys:

   ```json
   {
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://SEU-API.up.railway.app/api/:path*" },
       { "source": "/img/:path*", "destination": "https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/:path*" },
       { "source": "/gif/:path*", "destination": "https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/:path*" }
     ]
   }
   ```

3. Nas variáveis de build da Vercel, defina também `VITE_IMG_BASE`/`VITE_GIF_BASE`
   com as URLs do jsdelivr acima (mesmo efeito das rewrites de mídia).
4. `RP_ID`/`ORIGIN` da API passam a ser o domínio da Vercel.

## 4. Verificação

- `GET https://SEU-DOMINIO/api/health` deve responder `{"ok":true,...}`.
- Crie um perfil (botão **Criar perfil**) — no Supabase, a tabela `app_kv` ganha
  a linha `db` e cada login aparece em `audit_events`.
- Peso/treinos salvos aparecem em `user_state`.

## 5. Backup

Com Supabase, todo o estado vive no Postgres: use **Database → Backups** do
Supabase (plano pago) ou rode um dump periódico:

```bash
pg_dump "$DATABASE_URL" > backup-opengym.sql
# restaurar:
psql "$DATABASE_URL" < backup-opengym.sql
```

Chaves privadas de passkey nunca saem do dispositivo do usuário — backup do
banco cobre perfis, treinos, peso e convites.
