const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Europe/Istanbul";

// Türkçe ay isimleri → numara (Türkçe + ASCII varyantları)
const MONTHS = {
    ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4,
    mayıs: 5, mayis: 5, haziran: 6,
    temmuz: 7, ağustos: 8, agustos: 8,
    eylül: 9, eylul: 9, ekim: 10,
    kasım: 11, kasim: 11, aralık: 12, aralik: 12,
};

/**
 * Türkçe doğal dil tarih ifadesini ISO 8601 timestamp'e çevirir.
 * Europe/Istanbul timezone bazlı.
 *
 * Desteklenen formatlar:
 *   "20 şubat saat 15.30"
 *   "20 şubat 15:30"
 *   "20.02.2026 14:00"
 *   "20/02/2026 14.00"
 *   "20-02-2026 14:00"
 *   "yarın 15:00"
 *   "bugün 14.30"
 *   "3 mart"           (saat verilmezse 10:00 varsayılan)
 *
 * @param {string} input - Kullanıcıdan gelen tarih metni
 * @returns {{ iso: string|null, readable: string|null, error: string|null }}
 */
function parseTurkishDate(input) {
    if (!input || typeof input !== "string") {
        return { iso: null, readable: null, error: "Tarih boş." };
    }

    const raw = input.toLowerCase().trim();
    const now = dayjs().tz(TZ);

    let day = null;
    let month = null;
    let year = now.year();
    let hour = 10;
    let minute = 0;

    // ─── Saat extraction (önce çıkar) ─────────────────────
    // "saat 15.30" / "saat 15:30" / "15.30" / "15:00"
    const timePatterns = [
        /saat\s*(\d{1,2})[.:](\d{2})/i,
        /(\d{1,2})[.:](\d{2})\s*$/,
        /(\d{1,2})[.:](\d{2})/,
    ];

    for (const pat of timePatterns) {
        const m = raw.match(pat);
        if (m) {
            hour = parseInt(m[1], 10);
            minute = parseInt(m[2], 10);
            break;
        }
    }

    // ─── Pattern 1: "20.02.2026" / "20/02/2026" / "20-02-2026" ───
    const numericDate = raw.match(/(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})/);
    if (numericDate) {
        day = parseInt(numericDate[1], 10);
        month = parseInt(numericDate[2], 10);
        year = parseInt(numericDate[3], 10);
    }

    // ─── Pattern 2: "20 şubat" / "3 mart 2026" ───────────
    if (!day) {
        for (const [name, num] of Object.entries(MONTHS)) {
            if (raw.includes(name)) {
                month = num;
                // Gün: ay isminden önceki sayı
                const dayMatch = raw.match(new RegExp("(\\d{1,2})\\s*" + name));
                if (dayMatch) {
                    day = parseInt(dayMatch[1], 10);
                }
                // Yıl: ay isminden sonraki 4 haneli sayı
                const yearMatch = raw.match(new RegExp(name + "\\s*(\\d{4})"));
                if (yearMatch) {
                    year = parseInt(yearMatch[1], 10);
                }
                break;
            }
        }
    }

    // ─── Pattern 3: "bugün" / "yarın" ────────────────────
    if (!day) {
        if (raw.includes("bugün") || raw.includes("bugun")) {
            day = now.date();
            month = now.month() + 1;
            year = now.year();
        } else if (raw.includes("yarın") || raw.includes("yarin")) {
            const tomorrow = now.add(1, "day");
            day = tomorrow.date();
            month = tomorrow.month() + 1;
            year = tomorrow.year();
        }
    }

    // ─── Validation ───────────────────────────────────────
    if (!day || !month) {
        return {
            iso: null,
            readable: null,
            error: "Tarih anlaşılamadı. Lütfen '20 Şubat saat 15.30' veya '20.02.2026 14:00' formatında yazın.",
        };
    }

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return { iso: null, readable: null, error: "Geçersiz saat. 00:00 - 23:59 arasında olmalı." };
    }

    if (day < 1 || day > 31 || month < 1 || month > 12) {
        return { iso: null, readable: null, error: "Geçersiz gün veya ay." };
    }

    // ─── Build timestamp ─────────────────────────────────
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

    const parsed = dayjs.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", TZ);

    if (!parsed.isValid()) {
        return { iso: null, readable: null, error: "Geçersiz tarih." };
    }

    const iso = parsed.format();
    const readable = parsed.format("DD.MM.YYYY HH:mm");

    return { iso, readable, error: null };
}

module.exports = { parseTurkishDate, TZ };
