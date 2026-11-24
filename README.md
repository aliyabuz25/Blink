# Blink Standalone Backend & API

Bu klasör, **Blink** mesajlaşma, REST API ve WebRTC sesli arama sunucusunun `blink.octotech.az` sunucusuna kurulması için gereken **tüm eksiksiz dosyaları** içerir. 

Frontend (Next.js/React) bağımlılıklarından arındırılmış, ultra hafif ve yüksek performanslı saf Node.js + Express + Socket.IO + SQLite konteyneridir.

---

## 📁 Klasör Yapısı

```
blink-backend/
├── docker-compose.yml     # Traefik ve ağ tanımlı Docker Compose dosyası
├── Dockerfile             # Node.js 22 & SQLite optimizasyonlu imaj
├── index.js               # Express & Socket.IO WebRTC ve REST API çekirdeği
├── package.json           # Yalnızca backend bağımlılıkları (Next.js yok)
├── deploy.sh              # Tek komutla build & ayağa kaldırma betiği
├── .env                   # Üretim ortamı değişkenleri
├── .env.example           # Örnek ortam değişkenleri
├── public/                # Sabit medya ve avatar varlıkları (/assets/boombot.png vb.)
└── src/
    ├── db/
    │   ├── sqlite.js      # SQLite WAL veritabanı motoru & tablolar
    │   └── redis.js       # Redis pub/sub ve önbellekleme (isteğe bağlı)
    ├── routes/
    │   └── api.js         # Tüm REST API uç noktaları (/api/auth, /api/messages, vb.)
    └── services/
        └── boombot.js     # Yalnızca boombot sohbetlerine yanıt veren bot servisi
```

---

## 🚀 Sunucuya Kurulum (blink.octotech.az)

### 1. Dosyaları Sunucuya Gönderme (Mac Masaüstünden)

Terminal üzerinden şu komutla klasörü sunucunuza aktarabilirsiniz:
```bash
scp -r /Users/ali_new/Desktop/blink-backend kullanici@sunucu_ip_veya_host:/app/blink-backend
# veya rsync ile:
rsync -avz --exclude 'node_modules' --exclude 'data/*.db*' /Users/ali_new/Desktop/blink-backend/ kullanici@sunucu_ip_veya_host:/app/blink-backend/
```

### 2. Sunucuda Çalıştırma

Sunucuya SSH ile bağlanıp klasöre girin:
```bash
cd /app/blink-backend
chmod +x deploy.sh
./deploy.sh
```

Veya doğrudan Docker Compose komutuyla:
```bash
docker compose up -d --build
```

---

## 🔍 Sağlık Kontrolü & Test

Sunucu ayağa kalktıktan sonra aşağıdaki adreslerden test edebilirsiniz:

- **Sağlık Durumu (Healthcheck):**
  ```bash
  curl https://blink.octotech.az/health
  ```
  *Dönen Yanıt:*
  ```json
  {
    "status": "healthy",
    "service": "blink-backend",
    "version": "1.0.0",
    "port": 3000,
    "siteUrl": "https://blink.octotech.az"
  }
  ```

- **API Ana Sayfası:**
  ```bash
  curl https://blink.octotech.az/
  ```

- **WebSocket Bağlantı Noktası:**
  `wss://blink.octotech.az/socket.io`

---

## ⚙️ Yapılandırma & Ortam Değişkenleri

| Değişken | Değer | Açıklama |
|---|---|---|
| `PORT` | `3000` | Konteyner içi dinlenen port |
| `NODE_ENV` | `production` | Üretim çalışma modu |
| `SITE_URL` | `https://blink.octotech.az` | Canlı genel alan adı |
| `ALLOWED_ORIGINS` | `https://blink.octotech.az,http://blink.octotech.az,https://blink.octotechaz,http://blink.octotechaz` | CORS izinli originler |
| `DB_PATH` | `/app/data/blink.db` | Kalıcı SQLite veritabanı yolu |
| `UPLOADS_DIR` | `/app/uploads` | Yüklenen medya ve avatarlar |

---

## 🔒 Kalıcı Veri (Volumes)

- `/datastore/blink/uploads` -> `/app/uploads`
- `/datastore/blink/data` -> `/app/data`

Sunucu konteyneri yeniden başlatılsa veya güncellense bile veritabanı ve yüklenen dosyalar `/datastore/blink` altında güvenle korunur.
