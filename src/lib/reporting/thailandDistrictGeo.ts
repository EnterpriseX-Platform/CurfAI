/**
 * District (อำเภอ) point geometry for the three southern-border provinces
 * (Pattani/Yala/Narathiwat) — used by MapBlock's regionType="thailand-province"
 * to render district-level pins once a province is drilled into.
 *
 * Ported from a reference implementation's hand-vetted district seed data
 * (name + real lon/lat per amphoe). Districts are represented as POINTS,
 * not polygons — there is no district-level boundary data, matching how
 * the reference project itself models this (only province-level shapes
 * exist; districts/schools are pins).
 *
 * THAILAND_PROJ/projectLon/projectLat are the SAME equirectangular
 * projection used to bake THAILAND_PROVINCE_PATHS (thailandProvincePaths.ts)
 * — reusing it here is what makes a projected district point land in the
 * correct place relative to the already-rendered province shape.
 */

export const THAILAND_PROJ = { lon0: 97.34, lat0: 20.03, scale: 71.3 };

export function projectLon(lon: number): number {
  return (lon - THAILAND_PROJ.lon0) * THAILAND_PROJ.scale;
}
export function projectLat(lat: number): number {
  return (THAILAND_PROJ.lat0 - lat) * THAILAND_PROJ.scale;
}

export type ThailandDistrict = {
  key: string;
  provinceKey: string;
  th: string;
  lon: number;
  lat: number;
};

export const THAILAND_DISTRICTS: ThailandDistrict[] = [
  // Pattani (12 amphoe)
  { key: "mueangPattani", provinceKey: "pattani", th: "เมืองปัตตานี", lon: 101.25, lat: 6.87 },
  { key: "nongchik", provinceKey: "pattani", th: "หนองจิก", lon: 101.13, lat: 6.81 },
  { key: "khokpho", provinceKey: "pattani", th: "โคกโพธิ์", lon: 101.07, lat: 6.70 },
  { key: "maelan", provinceKey: "pattani", th: "แม่ลาน", lon: 101.16, lat: 6.67 },
  { key: "yarang", provinceKey: "pattani", th: "ยะรัง", lon: 101.30, lat: 6.76 },
  { key: "yaring", provinceKey: "pattani", th: "ยะหริ่ง", lon: 101.37, lat: 6.86 },
  { key: "panare", provinceKey: "pattani", th: "ปะนาเระ", lon: 101.49, lat: 6.83 },
  { key: "mayo", provinceKey: "pattani", th: "มายอ", lon: 101.40, lat: 6.70 },
  { key: "thungyangdaeng", provinceKey: "pattani", th: "ทุ่งยางแดง", lon: 101.49, lat: 6.63 },
  { key: "saiburi", provinceKey: "pattani", th: "สายบุรี", lon: 101.62, lat: 6.70 },
  { key: "maikaen", provinceKey: "pattani", th: "ไม้แก่น", lon: 101.69, lat: 6.62 },
  { key: "kapho", provinceKey: "pattani", th: "กะพ้อ", lon: 101.56, lat: 6.59 },

  // Yala (8 amphoe)
  { key: "mueangYala", provinceKey: "yala", th: "เมืองยะลา", lon: 101.28, lat: 6.54 },
  { key: "yaha", provinceKey: "yala", th: "ยะหา", lon: 101.13, lat: 6.50 },
  { key: "kabang", provinceKey: "yala", th: "กาบัง", lon: 100.99, lat: 6.42 },
  { key: "krongpinang", provinceKey: "yala", th: "กรงปินัง", lon: 101.31, lat: 6.42 },
  { key: "raman", provinceKey: "yala", th: "รามัน", lon: 101.43, lat: 6.48 },
  { key: "bannangsata", provinceKey: "yala", th: "บันนังสตา", lon: 101.25, lat: 6.25 },
  { key: "tharto", provinceKey: "yala", th: "ธารโต", lon: 101.21, lat: 6.10 },
  { key: "betong", provinceKey: "yala", th: "เบตง", lon: 101.07, lat: 5.78 },

  // Narathiwat (12 amphoe)
  { key: "mueangNarathiwat", provinceKey: "narathiwat", th: "เมืองนราธิวาส", lon: 101.82, lat: 6.42 },
  { key: "bacho", provinceKey: "narathiwat", th: "บาเจาะ", lon: 101.65, lat: 6.53 },
  { key: "yingo", provinceKey: "narathiwat", th: "ยี่งอ", lon: 101.70, lat: 6.38 },
  { key: "rueso", provinceKey: "narathiwat", th: "รือเสาะ", lon: 101.51, lat: 6.37 },
  { key: "sisakhon", provinceKey: "narathiwat", th: "ศรีสาคร", lon: 101.50, lat: 6.20 },
  { key: "chanae", provinceKey: "narathiwat", th: "จะแนะ", lon: 101.66, lat: 6.15 },
  { key: "chohairong", provinceKey: "narathiwat", th: "เจาะไอร้อง", lon: 101.86, lat: 6.28 },
  { key: "takbai", provinceKey: "narathiwat", th: "ตากใบ", lon: 102.04, lat: 6.25 },
  { key: "sungaipadi", provinceKey: "narathiwat", th: "สุไหงปาดี", lon: 101.90, lat: 6.13 },
  { key: "sungaikolok", provinceKey: "narathiwat", th: "สุไหงโก-ลก", lon: 101.97, lat: 6.03 },
  { key: "waeng", provinceKey: "narathiwat", th: "แว้ง", lon: 101.85, lat: 5.93 },
  { key: "sukhirin", provinceKey: "narathiwat", th: "สุคิริน", lon: 101.70, lat: 5.93 },
];
