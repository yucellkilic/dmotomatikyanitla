# DM Otomasyon

Instagram DM üzerinden randevu otomasyonu — Node.js + Express + Supabase

## Kurulum

```bash
npm install
```

## Environment Variables

`.env` dosyası oluşturun:

```env
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_ANON_KEY=your_anon_key
```

## Çalıştırma

```bash
node server.js
```

## Supabase Tablo Yapısı

```sql
-- İşletmeler
CREATE TABLE businesses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL
);

-- Randevular
CREATE TABLE appointments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  service TEXT NOT NULL,
  date TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- İşletme üyelikleri (admin panel erişimi)
CREATE TABLE business_members (
  business_id UUID NOT NULL REFERENCES businesses(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (business_id, user_id)
);
```

## Endpoints

| Method | URL | Açıklama |
|--------|-----|----------|
| `GET` | `/` | API durumu |
| `GET` | `/admin` | Admin panel |
| `GET` | `/api/config` | Frontend config (anon key) |
| `POST` | `/api/:slug/message` | İşletme bazlı chatbot |
| `POST` | `/chat` | Default işletme chatbot |

## Admin Panel Kullanımı

1. `http://localhost:3000/admin` adresine gidin
2. Supabase Auth ile kayıtlı e-posta/şifre ile giriş yapın
3. Birden fazla işletme üyeliğiniz varsa dropdown'dan seçin
4. Randevular otomatik listelenir
5. İsim veya telefon ile arayabilir, kolon başlıklarına tıklayarak sıralayabilirsiniz

> **Not:** Admin erişimi için `business_members` tablosunda kullanıcının üyeliği olmalıdır. RLS aktif olduğu için sadece yetkili olunan işletmelerin verileri görünür.