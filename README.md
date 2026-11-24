# Blink Standalone Backend (PostgreSQL Mandatory)

Bu repository, **Blink** mesajlaşma, REST API ve WebRTC arama servislerinin **PostgreSQL zorunlu** olarak yapılandırılmış tam sürümüdür. 

SQLite ve native C++ derleme araçları tamamen kaldırılmıştır. Portainer, Docker Swarm ve bulut ortamlarında %100 kararlı çalışacak şekilde saf JavaScript (`pg` modülü) ve `postgres:16-alpine` altyapısına geçirilmiştir.

---

## 📁 Mimari ve Servisler

- **blink-backend:** Saf Node.js 22 Express & Socket.IO WebRTC motoru (Port 3000)
- **blink-postgres:** PostgreSQL 16 Alpine kalıcı veritabanı konteyneri (Port 5432)

```
blink-backend/
├── docker-compose.yml     # Traefik, blink-backend & blink-postgres tanımlı Compose
├── Dockerfile             # Saf JS Node.js 22 imajı (0 C++ compile, hızlı build)
├── index.js               # WebRTC sinyalleşme, Socket.IO & API geçidi
├── package.json           # sqlite3 kaldırıldı, pg eklendi
├── deploy.sh              # Tek komutla PostgreSQL & Backend çalıştırma betiği
├── .env / .env.example    # PostgreSQL DATABASE_URL bağlantısı
├── public/                # Bot ve avatar görselleri
└── src/
    ├── db/
    │   ├── postgres.js    # PostgreSQL havuzu, retry döngüsü ve migration motoru
    │   └── sqlite.js      # Geriye dönük uyumluluk köprüsü
    ├── routes/api.js      # REST API uç noktaları (PostgreSQL optimize)
    └── services/boombot.js# BoomBot yapay zeka servisi
```

---

## ⚙️ Yapılandırma & Ortam Değişkenleri

| Değişken | Varsayılan Değer | Açıklama |
|---|---|---|
| `PORT` | `3000` | Backend konteyner içi dinlenen port |
| `NODE_ENV` | `production` | Çalışma modu |
| `SITE_URL` | `https://blink.octotech.az` | Canlı alan adı |
| `DATABASE_URL` | `postgres://blink_user:blink_secure_pass_2026@blink-postgres:5432/blink_db` | PostgreSQL bağlantı adresi |
| `UPLOADS_DIR` | `/app/uploads` | Kalıcı medya ve avatarlar |

---

## 🔒 Kalıcı Veri (Volumes)

- `/datastore/blink/postgres_data` -> `/var/lib/postgresql/data` (PostgreSQL veritabanı tabloları)
- `/datastore/blink/uploads` -> `/app/uploads` (Kullanıcı avatarları ve gönderilen medyalar)

---

## 🚀 Portainer Üzerinde Başlatma

1. Portainer Web Arayüzünde **Stacks -> Add Stack** seçeneğine tıklayın.
2. Repository URL: `https://github.com/aliyabuz25/Blink.git`
3. Branch: `main`
4. **Deploy the stack** butonuna tıklayın.

Konteyner otomatik olarak:
1. `blink-postgres` servisini ayağa kaldırır ve sağlık kontrolünü bekler.
2. `blink-backend` servisini başlatıp PostgreSQL tablolarını ve ilk seed verilerini oluşturur.
3. Traefik üzerinden `https://blink.octotech.az` adresini doğrudan yayına açar.
