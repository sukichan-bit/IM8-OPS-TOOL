// Task G — B2B Freight Cost Calculator.
// Estimates outbound freight cost for a B2B order given the shipping
// warehouse, the counted weight of the goods (always entered in kg — the
// only unit ops actually measures in), and the destination. Each warehouse
// ships on a different carrier/rate card, so this does not hardcode any
// $ pricing: rate cards are user-maintained data (see defaultRateCards()),
// edited in the browser and saved to localStorage by app.js, the same
// pattern as Task F's item master. This module only knows the *shape* of a
// rate card and how to price a shipment against one.
//
// A rate card can be either:
//   - "bracket": a table of weight ranges -> a flat price per destination
//     zone (the common "0-1kg = $20, 1-2kg = $28..." shape).
//   - "perUnit": a base fee + a per-kg/lb/oz rate (+ optional minimum
//     charge) per destination zone.
// Destination zones are either "manual" (a user-defined list, optionally
// with a country -> zone lookup so the customer's country picks the zone
// automatically) or "usps" — Stord's US domestic rates are priced by USPS
// zone (1-9), which this module derives automatically from the shipping
// warehouse's origin ZIP and the destination ZIP using a baked-in USPS
// Domestic Zone Chart (see USPS_ZONE_CHARTS below), rather than making the
// user look it up by hand.

// ---------- Unit conversion ----------
// kg is the ground truth (it's the only unit ops actually weighs in);
// everything else converts through it.
const KG_PER_LB = 0.45359237;
const OZ_PER_LB = 16;
const CM_PER_IN = 2.54;

function weightToKg(value, unit) {
  switch (unit) {
    case "kg": return value;
    case "lb": return value * KG_PER_LB;
    case "oz": return (value / OZ_PER_LB) * KG_PER_LB;
    default: throw new Error(`Unknown weight unit: ${unit}`);
  }
}
function weightFromKg(valueKg, unit) {
  switch (unit) {
    case "kg": return valueKg;
    case "lb": return valueKg / KG_PER_LB;
    case "oz": return (valueKg / KG_PER_LB) * OZ_PER_LB;
    default: throw new Error(`Unknown weight unit: ${unit}`);
  }
}
function convertWeight(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  return weightFromKg(weightToKg(value, fromUnit), toUnit);
}

function lengthToCm(value, unit) {
  if (unit === "cm") return value;
  if (unit === "in") return value * CM_PER_IN;
  throw new Error(`Unknown length unit: ${unit}`);
}
function convertLength(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  const cm = lengthToCm(value, fromUnit);
  return toUnit === "cm" ? cm : cm / CM_PER_IN;
}

// Volumetric (dimensional) weight. Divisor convention follows the carrier's
// own formula, keyed by which unit the dimensions are in: cm dims divide
// down to kg (e.g. /5000 or /6000), inch dims divide down to lb (e.g. /139
// or /166) — both are common carrier conventions, so the divisor is stored
// per rate card, not assumed. Returns { value, unit } in that native unit;
// caller converts to whatever unit it actually needs.
function volumetricWeight({ length, width, height, dimUnit, divisor }) {
  if (!divisor || !length || !width || !height) return { value: 0, unit: dimUnit === "in" ? "lb" : "kg" };
  const raw = (length * width * height) / divisor;
  return { value: raw, unit: dimUnit === "in" ? "lb" : "kg" };
}

// ---------- USPS Domestic Zone Chart (for Stord's zone-based rate cards) ----------
// Source: postcalc.usps.com/domesticzonechart, effective September 1, 2026.
// Keyed by the shipping warehouse's origin 3-digit ZIP prefix. Each chart is
// a flat, ascending list of destination-ZIP3 ranges -> zone (a handful of
// stray full-5-digit rows in USPS's own chart, always matching the zone of
// the 3-digit range around them, are dropped for a clean ZIP3 table), plus
// a short list of 5-digit exceptions (military/territory ZIPs) checked
// first. A zone string may carry a "*" (same NDC as origin / local) or "+"
// (has further 5-digit exceptions) suffix per USPS's own legend — the
// leading digit is what prices against a rate card; the suffix is kept
// alongside it for reference only.
// NOTE: USPS republishes this chart periodically (rate cases, ZIP
// realignments) — if quotes start looking off, re-pull the chart for these
// origin ZIP3s from the URL above and refresh the tables below.
const USPS_ZONE_CHARTS = {
  "303": { // Stord — Atlanta, GA (30349)
    ranges: [
      { lo: 5, hi: 5, zone: "5" }, { lo: 6, hi: 9, zone: "7" }, { lo: 10, hi: 34, zone: "5" },
      { lo: 35, hi: 35, zone: "6" }, { lo: 36, hi: 39, zone: "5" }, { lo: 40, hi: 49, zone: "6" },
      { lo: 50, hi: 57, zone: "5" }, { lo: 58, hi: 59, zone: "6" }, { lo: 60, hi: 89, zone: "5" },
      { lo: 90, hi: 99, zone: "5+" }, { lo: 100, hi: 149, zone: "5" }, { lo: 150, hi: 157, zone: "4" },
      { lo: 158, hi: 158, zone: "5" }, { lo: 159, hi: 162, zone: "4" }, { lo: 163, hi: 165, zone: "5" },
      { lo: 166, hi: 166, zone: "4" }, { lo: 167, hi: 171, zone: "5" }, { lo: 172, hi: 173, zone: "4" },
      { lo: 174, hi: 199, zone: "5" }, { lo: 200, hi: 209, zone: "4" }, { lo: 210, hi: 210, zone: "5" },
      { lo: 211, hi: 212, zone: "4" }, { lo: 214, hi: 218, zone: "4" }, { lo: 219, hi: 219, zone: "5" },
      { lo: 220, hi: 241, zone: "4" }, { lo: 242, hi: 243, zone: "3" }, { lo: 244, hi: 245, zone: "4" },
      { lo: 246, hi: 246, zone: "3" }, { lo: 247, hi: 268, zone: "4" }, { lo: 270, hi: 272, zone: "3" },
      { lo: 273, hi: 279, zone: "4" }, { lo: 280, hi: 282, zone: "3" }, { lo: 283, hi: 285, zone: "4" },
      { lo: 286, hi: 286, zone: "3" }, { lo: 287, hi: 287, zone: "2" }, { lo: 288, hi: 288, zone: "3" },
      { lo: 289, hi: 289, zone: "2" }, { lo: 290, hi: 295, zone: "3" }, { lo: 296, hi: 296, zone: "2" },
      { lo: 297, hi: 297, zone: "3" }, { lo: 298, hi: 298, zone: "3*" }, { lo: 299, hi: 299, zone: "3" },
      { lo: 300, hi: 303, zone: "1*" }, { lo: 304, hi: 304, zone: "3*" }, { lo: 305, hi: 310, zone: "2*" },
      { lo: 311, hi: 311, zone: "1*" }, { lo: 312, hi: 312, zone: "2*" }, { lo: 313, hi: 317, zone: "3" },
      { lo: 318, hi: 319, zone: "2*" }, { lo: 320, hi: 320, zone: "3" }, { lo: 321, hi: 321, zone: "4" },
      { lo: 322, hi: 325, zone: "3" }, { lo: 326, hi: 329, zone: "4" }, { lo: 330, hi: 330, zone: "5" },
      { lo: 331, hi: 342, zone: "4" }, { lo: 344, hi: 344, zone: "4" }, { lo: 346, hi: 347, zone: "4" },
      { lo: 349, hi: 349, zone: "4" }, { lo: 350, hi: 352, zone: "2*" }, { lo: 354, hi: 356, zone: "3*" },
      { lo: 357, hi: 362, zone: "2*" }, { lo: 363, hi: 365, zone: "3*" }, { lo: 366, hi: 366, zone: "4*" },
      { lo: 367, hi: 367, zone: "3*" }, { lo: 368, hi: 368, zone: "2*" }, { lo: 369, hi: 372, zone: "3" },
      { lo: 373, hi: 374, zone: "2*" }, { lo: 375, hi: 375, zone: "4" }, { lo: 376, hi: 376, zone: "3" },
      { lo: 377, hi: 377, zone: "2*" }, { lo: 378, hi: 379, zone: "3*" }, { lo: 380, hi: 381, zone: "4" },
      { lo: 382, hi: 385, zone: "3" }, { lo: 386, hi: 387, zone: "4" }, { lo: 388, hi: 388, zone: "3" },
      { lo: 389, hi: 392, zone: "4" }, { lo: 393, hi: 393, zone: "3" }, { lo: 394, hi: 395, zone: "4*" },
      { lo: 396, hi: 396, zone: "4" }, { lo: 397, hi: 398, zone: "3" }, { lo: 399, hi: 399, zone: "1*" },
      { lo: 400, hi: 403, zone: "4" }, { lo: 404, hi: 405, zone: "3" }, { lo: 406, hi: 406, zone: "4" },
      { lo: 407, hi: 409, zone: "3*" }, { lo: 410, hi: 412, zone: "4" }, { lo: 413, hi: 416, zone: "3" },
      { lo: 417, hi: 418, zone: "3*" }, { lo: 420, hi: 420, zone: "4" }, { lo: 421, hi: 423, zone: "3" },
      { lo: 424, hi: 424, zone: "4" }, { lo: 425, hi: 426, zone: "3*" }, { lo: 427, hi: 427, zone: "3" },
      { lo: 430, hi: 479, zone: "4" }, { lo: 480, hi: 480, zone: "5" }, { lo: 481, hi: 481, zone: "4" },
      { lo: 482, hi: 489, zone: "5" }, { lo: 490, hi: 492, zone: "4" }, { lo: 493, hi: 516, zone: "5" },
      { lo: 520, hi: 528, zone: "5" }, { lo: 530, hi: 532, zone: "5" }, { lo: 534, hi: 535, zone: "5" },
      { lo: 537, hi: 551, zone: "5" }, { lo: 553, hi: 555, zone: "5" }, { lo: 556, hi: 557, zone: "6" },
      { lo: 558, hi: 563, zone: "5" }, { lo: 564, hi: 567, zone: "6" }, { lo: 570, hi: 571, zone: "5" },
      { lo: 572, hi: 577, zone: "6" }, { lo: 580, hi: 587, zone: "6" }, { lo: 588, hi: 588, zone: "7" },
      { lo: 590, hi: 592, zone: "7" }, { lo: 593, hi: 593, zone: "6" }, { lo: 594, hi: 597, zone: "7" },
      { lo: 598, hi: 599, zone: "8" }, { lo: 600, hi: 602, zone: "5" }, { lo: 603, hi: 606, zone: "4" },
      { lo: 607, hi: 607, zone: "5" }, { lo: 608, hi: 609, zone: "4" }, { lo: 610, hi: 612, zone: "5" },
      { lo: 613, hi: 620, zone: "4" }, { lo: 622, hi: 631, zone: "4" }, { lo: 633, hi: 634, zone: "4" },
      { lo: 635, hi: 635, zone: "5" }, { lo: 636, hi: 639, zone: "4" }, { lo: 640, hi: 641, zone: "5" },
      { lo: 644, hi: 649, zone: "5" }, { lo: 650, hi: 658, zone: "4" }, { lo: 660, hi: 662, zone: "5" },
      { lo: 664, hi: 676, zone: "5" }, { lo: 677, hi: 677, zone: "6" }, { lo: 678, hi: 681, zone: "5" },
      { lo: 683, hi: 689, zone: "5" }, { lo: 690, hi: 693, zone: "6" }, { lo: 700, hi: 701, zone: "4" },
      { lo: 703, hi: 708, zone: "4" }, { lo: 710, hi: 714, zone: "4" }, { lo: 716, hi: 729, zone: "4" },
      { lo: 730, hi: 731, zone: "5" }, { lo: 733, hi: 741, zone: "5" }, { lo: 743, hi: 748, zone: "5" },
      { lo: 749, hi: 749, zone: "4" }, { lo: 750, hi: 754, zone: "5" }, { lo: 755, hi: 756, zone: "4" },
      { lo: 757, hi: 758, zone: "5" }, { lo: 759, hi: 759, zone: "4" }, { lo: 760, hi: 770, zone: "5" },
      { lo: 772, hi: 789, zone: "5" }, { lo: 790, hi: 790, zone: "6" }, { lo: 791, hi: 796, zone: "5" },
      { lo: 797, hi: 816, zone: "6" }, { lo: 820, hi: 820, zone: "6" }, { lo: 821, hi: 821, zone: "7" },
      { lo: 822, hi: 823, zone: "6" }, { lo: 824, hi: 825, zone: "7" }, { lo: 826, hi: 827, zone: "6" },
      { lo: 828, hi: 834, zone: "7" }, { lo: 835, hi: 838, zone: "8" }, { lo: 840, hi: 847, zone: "7" },
      { lo: 850, hi: 853, zone: "7" }, { lo: 855, hi: 857, zone: "7" }, { lo: 859, hi: 860, zone: "7" },
      { lo: 863, hi: 865, zone: "7" }, { lo: 870, hi: 871, zone: "6" }, { lo: 873, hi: 885, zone: "6" },
      { lo: 889, hi: 891, zone: "7" }, { lo: 893, hi: 895, zone: "8" }, { lo: 897, hi: 897, zone: "8" },
      { lo: 898, hi: 898, zone: "7" }, { lo: 900, hi: 908, zone: "8" }, { lo: 910, hi: 921, zone: "8" },
      { lo: 922, hi: 922, zone: "7" }, { lo: 923, hi: 928, zone: "8" }, { lo: 930, hi: 961, zone: "8" },
      { lo: 962, hi: 966, zone: "8+" }, { lo: 968, hi: 968, zone: "8" }, { lo: 969, hi: 969, zone: "9+" },
      { lo: 970, hi: 986, zone: "8" }, { lo: 988, hi: 999, zone: "8" },
    ],
    exceptions: [
      { lo: 9000, hi: 9999, zone: "4" }, { lo: 96200, hi: 96699, zone: "4" },
      { lo: 96900, hi: 96938, zone: "8" }, { lo: 96945, hi: 96959, zone: "8" },
      { lo: 96961, hi: 96969, zone: "8" }, { lo: 96971, hi: 96999, zone: "8" },
    ],
  },
  "894": { // Stord — McCarran, NV (89434)
    ranges: [
      { lo: 5, hi: 89, zone: "8" }, { lo: 90, hi: 99, zone: "8+" }, { lo: 100, hi: 212, zone: "8" },
      { lo: 214, hi: 268, zone: "8" }, { lo: 270, hi: 342, zone: "8" }, { lo: 344, hi: 344, zone: "8" },
      { lo: 346, hi: 347, zone: "8" }, { lo: 349, hi: 349, zone: "8" }, { lo: 350, hi: 352, zone: "7" },
      { lo: 354, hi: 358, zone: "7" }, { lo: 359, hi: 364, zone: "8" }, { lo: 365, hi: 365, zone: "7" },
      { lo: 366, hi: 366, zone: "8" }, { lo: 367, hi: 367, zone: "7" }, { lo: 368, hi: 368, zone: "8" },
      { lo: 369, hi: 372, zone: "7" }, { lo: 373, hi: 374, zone: "8" }, { lo: 375, hi: 375, zone: "7" },
      { lo: 376, hi: 379, zone: "8" }, { lo: 380, hi: 397, zone: "7" }, { lo: 398, hi: 399, zone: "8" },
      { lo: 400, hi: 406, zone: "7" }, { lo: 407, hi: 409, zone: "8" }, { lo: 410, hi: 410, zone: "7" },
      { lo: 411, hi: 418, zone: "8" }, { lo: 420, hi: 427, zone: "7" }, { lo: 430, hi: 432, zone: "8" },
      { lo: 433, hi: 436, zone: "7" }, { lo: 437, hi: 449, zone: "8" }, { lo: 450, hi: 455, zone: "7" },
      { lo: 456, hi: 457, zone: "8" }, { lo: 458, hi: 499, zone: "7" }, { lo: 500, hi: 516, zone: "6" },
      { lo: 520, hi: 527, zone: "6" }, { lo: 528, hi: 528, zone: "7" }, { lo: 530, hi: 532, zone: "7" },
      { lo: 534, hi: 535, zone: "7" }, { lo: 537, hi: 537, zone: "7" }, { lo: 538, hi: 538, zone: "6" },
      { lo: 539, hi: 539, zone: "7" }, { lo: 540, hi: 540, zone: "6" }, { lo: 541, hi: 545, zone: "7" },
      { lo: 546, hi: 548, zone: "6" }, { lo: 549, hi: 549, zone: "7" }, { lo: 550, hi: 551, zone: "6" },
      { lo: 553, hi: 555, zone: "6" }, { lo: 556, hi: 556, zone: "7" }, { lo: 557, hi: 567, zone: "6" },
      { lo: 570, hi: 572, zone: "6" }, { lo: 573, hi: 577, zone: "5" }, { lo: 580, hi: 584, zone: "6" },
      { lo: 585, hi: 588, zone: "5" }, { lo: 590, hi: 591, zone: "4" }, { lo: 592, hi: 593, zone: "5" },
      { lo: 594, hi: 594, zone: "4" }, { lo: 595, hi: 595, zone: "5" }, { lo: 596, hi: 599, zone: "4" },
      { lo: 600, hi: 620, zone: "7" }, { lo: 622, hi: 631, zone: "7" }, { lo: 633, hi: 633, zone: "7" },
      { lo: 634, hi: 635, zone: "6" }, { lo: 636, hi: 639, zone: "7" }, { lo: 640, hi: 641, zone: "6" },
      { lo: 644, hi: 653, zone: "6" }, { lo: 654, hi: 654, zone: "7" }, { lo: 655, hi: 658, zone: "6" },
      { lo: 660, hi: 662, zone: "6" }, { lo: 664, hi: 675, zone: "6" }, { lo: 676, hi: 679, zone: "5" },
      { lo: 680, hi: 681, zone: "6" }, { lo: 683, hi: 687, zone: "6" }, { lo: 688, hi: 693, zone: "5" },
      { lo: 700, hi: 701, zone: "7" }, { lo: 703, hi: 708, zone: "7" }, { lo: 710, hi: 714, zone: "7" },
      { lo: 716, hi: 725, zone: "7" }, { lo: 726, hi: 731, zone: "6" }, { lo: 733, hi: 738, zone: "6" },
      { lo: 739, hi: 739, zone: "5" }, { lo: 740, hi: 741, zone: "6" }, { lo: 743, hi: 755, zone: "6" },
      { lo: 756, hi: 756, zone: "7" }, { lo: 757, hi: 757, zone: "6" }, { lo: 758, hi: 759, zone: "7" },
      { lo: 760, hi: 769, zone: "6" }, { lo: 770, hi: 770, zone: "7" }, { lo: 772, hi: 779, zone: "7" },
      { lo: 780, hi: 780, zone: "6" }, { lo: 781, hi: 781, zone: "7" }, { lo: 782, hi: 782, zone: "6" },
      { lo: 783, hi: 785, zone: "7" }, { lo: 786, hi: 788, zone: "6" }, { lo: 789, hi: 789, zone: "7" },
      { lo: 790, hi: 791, zone: "5" }, { lo: 792, hi: 798, zone: "6" }, { lo: 799, hi: 812, zone: "5" },
      { lo: 813, hi: 816, zone: "4" }, { lo: 820, hi: 820, zone: "5" }, { lo: 821, hi: 821, zone: "4" },
      { lo: 822, hi: 822, zone: "5" }, { lo: 823, hi: 825, zone: "4" }, { lo: 826, hi: 828, zone: "5" },
      { lo: 829, hi: 831, zone: "4" }, { lo: 832, hi: 833, zone: "3" }, { lo: 834, hi: 835, zone: "4" },
      { lo: 836, hi: 837, zone: "3" }, { lo: 838, hi: 838, zone: "4" }, { lo: 840, hi: 842, zone: "4" },
      { lo: 843, hi: 843, zone: "3" }, { lo: 844, hi: 847, zone: "4" }, { lo: 850, hi: 853, zone: "5" },
      { lo: 855, hi: 857, zone: "5" }, { lo: 859, hi: 859, zone: "5" }, { lo: 860, hi: 860, zone: "4" },
      { lo: 863, hi: 865, zone: "4" }, { lo: 870, hi: 871, zone: "5" }, { lo: 873, hi: 885, zone: "5" },
      { lo: 889, hi: 891, zone: "4" }, { lo: 893, hi: 893, zone: "2" }, { lo: 894, hi: 894, zone: "1*" },
      { lo: 895, hi: 895, zone: "2*" }, { lo: 897, hi: 897, zone: "3*" }, { lo: 898, hi: 898, zone: "2" },
      { lo: 900, hi: 908, zone: "4" }, { lo: 910, hi: 918, zone: "4" }, { lo: 919, hi: 919, zone: "5" },
      { lo: 920, hi: 928, zone: "4" }, { lo: 930, hi: 935, zone: "4" }, { lo: 936, hi: 941, zone: "4*" },
      { lo: 942, hi: 942, zone: "3*" }, { lo: 943, hi: 951, zone: "4*" }, { lo: 952, hi: 953, zone: "3*" },
      { lo: 954, hi: 954, zone: "4*" }, { lo: 955, hi: 961, zone: "3*" }, { lo: 962, hi: 966, zone: "4*+" },
      { lo: 968, hi: 968, zone: "8" }, { lo: 969, hi: 969, zone: "9+" }, { lo: 970, hi: 974, zone: "4" },
      { lo: 975, hi: 975, zone: "3" }, { lo: 976, hi: 976, zone: "2" }, { lo: 977, hi: 978, zone: "3" },
      { lo: 979, hi: 979, zone: "2" }, { lo: 980, hi: 986, zone: "4" }, { lo: 988, hi: 994, zone: "4" },
      { lo: 995, hi: 996, zone: "7" }, { lo: 997, hi: 997, zone: "8" }, { lo: 998, hi: 998, zone: "7" },
      { lo: 999, hi: 999, zone: "6" },
    ],
    exceptions: [
      { lo: 9000, hi: 9999, zone: "7" }, { lo: 96200, hi: 96699, zone: "7" },
      { lo: 96900, hi: 96938, zone: "8" }, { lo: 96945, hi: 96959, zone: "8" },
      { lo: 96961, hi: 96969, zone: "8" }, { lo: 96971, hi: 96999, zone: "8" },
    ],
  },
};

function normalizeUspsZone(raw) {
  const m = /^(\d+)/.exec(String(raw));
  return m ? m[1] : String(raw);
}

// Returns { raw, zone } for a matched entry, { error } if the ZIP can't be
// read or the origin has no chart, or null if genuinely nothing matched
// (shouldn't happen — the chart covers 000-999 — but fails safe).
function lookupUspsZone(originZip3, destZip) {
  const chart = USPS_ZONE_CHARTS[originZip3];
  if (!chart) return { error: `No USPS zone chart configured for origin ZIP3 "${originZip3}".` };
  const digits = String(destZip || "").replace(/\D/g, "");
  if (digits.length < 5) return { error: "Enter a 5-digit US destination ZIP code." };
  const zip5 = parseInt(digits.slice(0, 5), 10);
  for (const ex of chart.exceptions) {
    if (zip5 >= ex.lo && zip5 <= ex.hi) return { raw: ex.zone, zone: normalizeUspsZone(ex.zone) };
  }
  const zip3 = parseInt(digits.slice(0, 3), 10);
  for (const r of chart.ranges) {
    if (zip3 >= r.lo && zip3 <= r.hi) return { raw: r.zone, zone: normalizeUspsZone(r.zone) };
  }
  return { error: `No USPS zone found for ZIP ${digits} — double check the destination ZIP code.` };
}

// ---------- Warehouses ----------
const FREIGHT_WAREHOUSES = [
  { id: "HK", name: "HK", weightUnit: "kg", dimUnit: "cm", address: "Hong Kong" },
  { id: "UK", name: "UK", weightUnit: "kg", dimUnit: "cm", address: "Unit 2, Tungsten Park, Bardon Rd, Coalville LE67 1TL, United Kingdom" },
  { id: "NL", name: "NL", weightUnit: "kg", dimUnit: "cm", address: "Mercuriusstraat 5E, 6468 ES Kerkrade, The Netherlands" },
  { id: "US_GPS", name: "US GPS", weightUnit: "lb", dimUnit: "in", address: "545 Monmouth Rd, Bldg#2, Jackson Township, NJ 08527, US" },
  { id: "US_STORD_ATL", name: "US Stord (Atlanta, GA)", weightUnit: "lb", dimUnit: "in", address: "5195 Mason Road, Atlanta, GA 30349, USA", uspsOriginZip3: "303" },
  { id: "US_STORD_RNO", name: "US Stord (McCarran, NV)", weightUnit: "lb", dimUnit: "in", address: "727 Milan Dr. Suite 115, McCarran, NV 89434, USA", uspsOriginZip3: "894" },
];

function getWarehouse(id) {
  return FREIGHT_WAREHOUSES.find((w) => w.id === id) || null;
}

// ---------- Rate card model ----------
let rateCardSeq = 0;
function newRateCardId() {
  rateCardSeq += 1;
  return `rc_${Date.now().toString(36)}_${rateCardSeq}`;
}

function emptyManualCard(warehouseId, name, weightUnit, dimUnit) {
  return {
    id: newRateCardId(),
    warehouseId,
    name,
    mode: "bracket", // "bracket" | "perUnit"
    weightUnit,
    dimUnit,
    zoneSource: "manual", // "manual" | "usps"
    zones: ["All"],
    countryZoneMap: {}, // country name -> zone name; empty = user picks zone directly
    dimDivisor: null,
    brackets: [{ min: 0, max: null, prices: { All: 0 } }],
    perUnit: { All: { base: 0, rate: 0, min: 0 } },
    // A flat fee added to every parcel on top of the bracket/perUnit price —
    // for carrier surcharges that apply to every package regardless of zone
    // or weight (e.g. Royal Mail's "Green Surcharge" + "Peak Season
    // Surcharge" — see UK rate card notes below). Zone- or weight-specific
    // surcharges belong baked into the bracket/perUnit price itself instead
    // (see notes); this is only for the always-on, zone-independent ones.
    flatSurcharge: 0,
    // ISO date strings (or null) — informational, surfaced as a warning by
    // quoteFreight() when the card is past its expiry, but never blocks a
    // quote (an expired rate card is still the best estimate available
    // until a fresh one is entered/imported).
    effectiveDate: null,
    expiryDate: null,
    notes: "",
  };
}

function emptyUspsCard(warehouseId, name, weightUnit, dimUnit) {
  const zones = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const zeros = Object.fromEntries(zones.map((z) => [z, 0]));
  return {
    id: newRateCardId(),
    warehouseId,
    name,
    mode: "bracket",
    weightUnit,
    dimUnit,
    zoneSource: "usps",
    zones,
    countryZoneMap: {},
    dimDivisor: null,
    brackets: [{ min: 0, max: 1, prices: { ...zeros } }],
    perUnit: Object.fromEntries(zones.map((z) => [z, { base: 0, rate: 0, min: 0 }])),
    flatSurcharge: 0,
    effectiveDate: null,
    expiryDate: null,
    notes: "",
  };
}

// ---------- UK (OPS-WH02) — real rate cards ----------
// Source: "RS UK eFulfillment Rate_VIP4.1_IM8_2026.4.1.xlsx" (provided by
// the user 2026-09-11), Royal Mail-UK / DPD- UK / DPD-Non-UK tabs. Only
// Royal Mail and DPD are active services for this warehouse (Evri/Yodel
// tabs exist in the file but are not in use, so not seeded here).
//
// Each card folds in the surcharges that always apply for a given zone (so
// the price is a realistic all-in estimate), and leaves genuinely
// conditional/exceptional surcharges (oversize, return/redelivery,
// customs duty, London Congestion Fee, etc.) out of the price — those are
// listed in `notes` instead of guessed at:
//   - Royal Mail: "Remote Area Surcharge" (Area 2 +£2.50, Area 3 +£2.00) is
//     baked into the Area 2/3 bracket prices — it's not conditional, it IS
//     what defines those zones as remote. "Green Surcharge" (£0.05) and
//     "Peak Season Surcharge" (£0.12) apply to every package regardless of
//     zone, so they're the flatSurcharge (£0.17 total).
//   - DPD (UK): "Northern Ireland Clearance Surcharge" (£0.60) applies to
//     every Zone 4 package, baked into that zone's price. Fuel surcharge
//     is £0, so flatSurcharge is £0.
//   - DPD (Non-UK): rates already fuel-inclusive; no flat/zone surcharge
//     to fold in from this sheet.
function ukRoyalMailCard() {
  const card = emptyManualCard("UK", "Royal Mail (UK domestic)", "kg", "cm");
  card.zones = ["Area 1", "Area 2", "Area 3"];
  card.brackets = [
    { min: 0, max: 2, prices: { "Area 1": 2.3, "Area 2": 7.3, "Area 3": 6.3 } },
    { min: 2.01, max: 5, prices: { "Area 1": 3.1, "Area 2": 8.1, "Area 3": 7.1 } },
    { min: 5.01, max: 10, prices: { "Area 1": 3.6, "Area 2": 8.6, "Area 3": 7.6 } },
    { min: 10.01, max: 15, prices: { "Area 1": 4.15, "Area 2": 9.15, "Area 3": 8.15 } },
    { min: 15.01, max: 20, prices: { "Area 1": 4.75, "Area 2": 9.75, "Area 3": 8.75 } },
  ];
  card.flatSurcharge = 0.17; // Green Surcharge £0.05 + Peak Season Surcharge £0.12, every package
  card.notes =
    "RM Tracked Parcel_48H (RM_TR48). Area 1 = rest of UK. Area 2 (postcodes IV, HS, KA27-28, KW, PA20-49, " +
    "PA60-78, PA80, PH17-26, PH30-44, PH49-50, ZE, FK20, GY, JE, IM) and Area 3 (BT, TR21-25, AB35-38, AB53-56, " +
    "FK18-19, PO30-41) prices already include the Remote Area Surcharge (Area 2 +£2.50 / Area 3 +£2.00). Max " +
    "weight 20kg; dims must be under 61x46x46cm or Oversize Surcharge (£20) applies — not included here. Other " +
    "surcharges not included (quote separately if applicable): Return Shipping Fee (= outbound rate), Redelivery " +
    "Fee (£2.30), BFPO not serviceable.";
  return card;
}

function ukDpdUkCard() {
  const card = emptyManualCard("UK", "DPD (UK domestic)", "kg", "cm");
  card.zones = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];
  card.brackets = [
    { min: 0, max: 30, prices: { "Zone 1": 6.45, "Zone 2": 21, "Zone 3": 18, "Zone 4": 13.6, "Zone 5": 33.5 } },
  ];
  card.flatSurcharge = 0;
  card.notes =
    "DPD parcel (DPDUKN / DPDUK2). Zone 1 = Mainland. Zone 2 = Channel Isles (GY, JE). Zone 3 = Scottish " +
    "Highlands/Islands + Isle of Man (AB36-38, FK17-21, IV1-56, IV63, KA27-28, KW1-17, PA20-49, PA60-80, " +
    "PH19-26, PH30-44, PH49-50, HS1-9, ZE1-3, IM1-9). Zone 4 = Northern Ireland (BT1-99) — price already " +
    "includes the Northern Ireland Clearance Surcharge (£0.60/order). Zone 5 = Isles of Scilly (TR21-25). Max " +
    "30kg, 100x70x60cm, girth <230cm or Oversize Surcharge (£24) applies — not included here. Customs duty " +
    "(Zone 2 / Isle of Man) charged at cost, not included. London Congestion Fee (£1.50, specific London " +
    "postcodes within Zone 1) not included.";
  return card;
}

function ukDpdNonUkCard() {
  const card = emptyManualCard("UK", "DPD (Non-UK: UAE / Israel / Saudi / Norway)", "kg", "cm");
  card.zones = ["UAE", "Israel", "Saudi Arabia", "Norway"];
  card.countryZoneMap = { UAE: "UAE", Israel: "Israel", "Saudi Arabia": "Saudi Arabia", Norway: "Norway" };
  card.brackets = [
    { min: 0, max: 0.5, prices: { UAE: 12.5, Israel: 20.7, "Saudi Arabia": 18.55, Norway: 25.95 } },
    { min: 0.51, max: 1, prices: { UAE: 15.5, Israel: 25, "Saudi Arabia": 22.5, Norway: 29.5 } },
    { min: 1.01, max: 1.5, prices: { UAE: 17.95, Israel: 29.2, "Saudi Arabia": 25.65, Norway: 33.5 } },
    { min: 1.51, max: 2, prices: { UAE: 19.73, Israel: 33.45, "Saudi Arabia": 29.8, Norway: 36.5 } },
    { min: 2.01, max: 2.5, prices: { UAE: 22.92, Israel: 37.71, "Saudi Arabia": 34.5, Norway: 39.95 } },
    { min: 2.51, max: 3, prices: { UAE: 26.1, Israel: 41.95, "Saudi Arabia": 39, Norway: 43.5 } },
    { min: 3.01, max: 5, prices: { UAE: 38.84, Israel: 58.95, "Saudi Arabia": 55.65, Norway: 58.2 } },
    { min: 5.01, max: 10, prices: { UAE: 67.5, Israel: 138.5, "Saudi Arabia": 118.95, Norway: 99.89 } },
  ];
  card.flatSurcharge = 0;
  card.notes =
    "Max weight 10kg, max length 100cm, L+H+W < 120cm. Israel service is suspended at the moment (per rate " +
    "card notes) — confirm before quoting. Rates exclude UK VAT. DDP admin fee/duties charged at cost, not " +
    "included.";
  return card;
}

// ---------- Import: "US-to-Global eCom Parcel Rate" style sheets ----------
// Some rate cards (e.g. GPS/USOPS-WH04's international parcel rates) are
// far too large to hand-type or bake into source — tens of destination
// countries x 60+ weight-break rows. Rather than embed that as static
// data (which also can't be refreshed when the carrier reissues rates),
// this parses the sheet's own layout at import time: a "Destinations" row
// of country names, a "Terms" row (DDP/DDU), a "Dim Factor" row, a
// "Minimum" row, "Effective Date:"/"Expired Date:" rows, then one row per
// weight break point (lb) with a price per country column. Returns
// { card } or { error }. rawRows: raw 2D array, e.g. from
// io.sheetToRawRows(wb, sheetName, null).
function excelSerialToIsoDate(serial) {
  if (serial instanceof Date) return isNaN(serial.getTime()) ? null : serial.toISOString().slice(0, 10);
  if (typeof serial !== "number" || !isFinite(serial)) return null;
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
}

function parseUsToGlobalRateSheet(rawRows, opts) {
  opts = opts || {};
  const firstCell = (row) => (row && row[0] != null ? String(row[0]).trim() : "");

  const destRowIdx = rawRows.findIndex((r) => /^destinations?$/i.test(firstCell(r)));
  if (destRowIdx < 0) {
    return { error: 'Could not find a "Destinations" row in column A — this doesn\'t look like a US-to-Global rate sheet.' };
  }
  const destRow = rawRows[destRowIdx];
  const zoneCols = [];
  for (let c = 1; c < destRow.length; c++) {
    const name = destRow[c] == null ? "" : String(destRow[c]).trim();
    if (name) zoneCols.push({ col: c, name });
  }
  if (!zoneCols.length) return { error: 'Found a "Destinations" row but no destination names in it.' };

  const termsRowIdx = rawRows.findIndex((r) => /^terms$/i.test(firstCell(r)));
  let terms = "";
  if (termsRowIdx >= 0) {
    const termsRow = rawRows[termsRowIdx];
    const found = zoneCols.map((z) => termsRow[z.col]).find((v) => v != null && String(v).trim());
    terms = found ? String(found).trim() : "";
  }

  const dimRowIdx = rawRows.findIndex((r) => /^dim\s*factor$/i.test(firstCell(r)));
  let dimDivisor = null;
  if (dimRowIdx >= 0) {
    const dimRow = rawRows[dimRowIdx];
    const found = zoneCols.map((z) => dimRow[z.col]).find((v) => typeof v === "number" && v > 0);
    if (found) dimDivisor = found;
  }

  const minRowIdx = rawRows.findIndex((r) => /^minimum$/i.test(firstCell(r)));
  let hasNonzeroMinimum = false;
  if (minRowIdx >= 0) {
    const minRow = rawRows[minRowIdx];
    hasNonzeroMinimum = zoneCols.some((z) => Number(minRow[z.col]) > 0);
  }

  // Date rows are labelled in column A but the serial/Date value's column
  // isn't consistent between sheets — scan the whole row for the first
  // plausible value instead of assuming a fixed column.
  const findDateRow = (label) => rawRows.find((r) => firstCell(r).toLowerCase().indexOf(label) === 0);
  const extractDateValue = (row) => (row || []).find((v) => v instanceof Date || (typeof v === "number" && v > 30000 && v < 80000));
  const effectiveDate = excelSerialToIsoDate(extractDateValue(findDateRow("effective date")));
  const expiredRow = findDateRow("expired date") || findDateRow("expiry date");
  const expiryDate = excelSerialToIsoDate(extractDateValue(expiredRow));

  // Weight break points (lb) start right after the "...Transit Time"
  // header row (falls back to right after the Minimum row if that header
  // isn't found), and run while column A keeps parsing as a positive
  // number — the first non-numeric/blank row ends the table.
  const headerRowIdx = rawRows.findIndex((r) => /transit/i.test(firstCell(r)));
  const startIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : (minRowIdx >= 0 ? minRowIdx + 1 : destRowIdx + 1);
  const brackets = [];
  let prevMax = 0;
  for (let r = startIdx; r < rawRows.length; r++) {
    const weight = parseFloat(firstCell(rawRows[r]));
    if (!(weight > 0)) break;
    const row = rawRows[r];
    const prices = {};
    for (const z of zoneCols) {
      const v = row[z.col];
      prices[z.name] = typeof v === "number" ? Math.round(v * 100) / 100 : (parseFloat(v) || 0);
    }
    const min = brackets.length ? Math.round((prevMax + 0.01) * 100) / 100 : 0;
    brackets.push({ min, max: weight, prices });
    prevMax = weight;
  }
  if (!brackets.length) {
    return { error: "Found destination columns but no weight-break rows with prices under them — check the sheet layout." };
  }

  const card = emptyManualCard(
    opts.warehouseId || "US_GPS",
    opts.cardName || `US to Global${terms ? ` (${terms})` : ""}`,
    opts.weightUnit || "lb",
    opts.dimUnit || "in"
  );
  card.zones = zoneCols.map((z) => z.name);
  card.countryZoneMap = Object.fromEntries(card.zones.map((n) => [n, n]));
  card.brackets = brackets;
  card.dimDivisor = dimDivisor;
  card.effectiveDate = effectiveDate;
  card.expiryDate = expiryDate;
  const notes = [];
  if (terms) notes.push(`Terms: ${terms}.`);
  if (effectiveDate || expiryDate) notes.push(`Effective ${effectiveDate || "?"} to ${expiryDate || "?"} per source file.`);
  if (hasNonzeroMinimum) {
    notes.push('This sheet has a non-zero per-destination "Minimum" charge that this tool does not yet apply automatically — check the Minimum row in the source file.');
  }
  card.notes = notes.join(" ");
  return { card };
}

// Seed: one starter rate card per warehouse. UK (OPS-WH02) ships with the
// warehouse's real, current Royal Mail + DPD cards (see above) since we
// have them; the rest start blank for the user to fill in (real numbers
// are the user's own commercial data — this tool never guesses at a $
// figure). Stord's cards start pre-wired for USPS zone-based pricing
// since that structure is fixed; HK/NL/US GPS start as a single manual
// "All" zone the user can rename/split into countries.
function defaultRateCards() {
  return {
    HK: [emptyManualCard("HK", "HK rate card", "kg", "cm")],
    UK: [ukRoyalMailCard(), ukDpdUkCard(), ukDpdNonUkCard()],
    NL: [emptyManualCard("NL", "NL rate card", "kg", "cm")],
    US_GPS: [emptyManualCard("US_GPS", "US GPS rate card", "lb", "in")],
    US_STORD_ATL: [emptyUspsCard("US_STORD_ATL", "Stord ATL — USPS zone rate card", "lb", "in")],
    US_STORD_RNO: [emptyUspsCard("US_STORD_RNO", "Stord RNO — USPS zone rate card", "lb", "in")],
  };
}

function addZone(card, zoneName) {
  const name = String(zoneName || "").trim();
  if (!name || card.zones.includes(name)) return;
  card.zones.push(name);
  for (const row of card.brackets) row.prices[name] = 0;
  card.perUnit[name] = { base: 0, rate: 0, min: 0 };
}
function removeZone(card, zoneName) {
  if (card.zones.length <= 1) return; // always keep at least one zone
  card.zones = card.zones.filter((z) => z !== zoneName);
  for (const row of card.brackets) delete row.prices[zoneName];
  delete card.perUnit[zoneName];
  for (const country of Object.keys(card.countryZoneMap)) {
    if (card.countryZoneMap[country] === zoneName) delete card.countryZoneMap[country];
  }
}
function addBracketRow(card) {
  const prices = Object.fromEntries(card.zones.map((z) => [z, 0]));
  card.brackets.push({ min: 0, max: null, prices });
  return card.brackets[card.brackets.length - 1];
}
function removeBracketRow(card, index) {
  card.brackets.splice(index, 1);
}

// ---------- Pricing ----------

// Splits the shipment's total weight evenly across parcelCount parcels,
// converts to the card's own weight unit, and takes the greater of that
// and the volumetric weight (if the card has a dim divisor and dims were
// given) — the standard "chargeable weight" a carrier actually bills on.
function computeChargeableWeightPerParcel({ totalWeightKg, parcelCount, dims, card }) {
  const count = Math.max(1, parcelCount || 1);
  const perParcelKg = totalWeightKg / count;
  const actual = convertWeight(perParcelKg, "kg", card.weightUnit);
  let volumetric = 0;
  if (card.dimDivisor && dims && dims.length && dims.width && dims.height) {
    const vol = volumetricWeight({
      length: dims.length, width: dims.width, height: dims.height,
      dimUnit: dims.unit || card.dimUnit, divisor: card.dimDivisor,
    });
    volumetric = convertWeight(vol.value, vol.unit, card.weightUnit);
  }
  return Math.max(actual, volumetric);
}

function priceForZone(card, zone, weight) {
  if (card.mode === "bracket") {
    const row = card.brackets.find((b) => weight >= b.min && (b.max == null || weight <= b.max));
    if (!row) {
      return { error: `No weight bracket on "${card.name}" covers ${weight.toFixed(2)} ${card.weightUnit} — add a bracket that covers this weight.` };
    }
    const price = row.prices[zone];
    if (price == null || price === "") {
      return { error: `No price set for zone "${zone}" on this bracket of "${card.name}".` };
    }
    return { price: Number(price) };
  }
  const cfg = card.perUnit[zone];
  if (!cfg) return { error: `No per-unit rate configured for zone "${zone}" on "${card.name}".` };
  const price = Math.max((Number(cfg.base) || 0) + (Number(cfg.rate) || 0) * weight, Number(cfg.min) || 0);
  return { price };
}

// Resolves which price column ("zone") applies to a destination, given the
// card's zone source. dest = { country, zone, zip }.
function resolveZone(card, dest) {
  dest = dest || {};
  if (card.zoneSource === "usps") {
    const wh = getWarehouse(card.warehouseId);
    if (!wh || !wh.uspsOriginZip3) return { error: "This warehouse has no USPS origin ZIP configured for zone lookup." };
    const z = lookupUspsZone(wh.uspsOriginZip3, dest.zip);
    if (z.error) return z;
    return { zone: z.zone, raw: z.raw };
  }
  if (card.zones.length === 1) return { zone: card.zones[0] };
  if (dest.zone && card.zones.includes(dest.zone)) return { zone: dest.zone };
  if (dest.country && card.countryZoneMap[dest.country]) return { zone: card.countryZoneMap[dest.country] };
  return { error: "Pick a destination zone (or country) for this rate card." };
}

// Full quote: resolves the zone, computes chargeable weight, prices it,
// and totals across parcels. Returns { error } on any failure, or the
// quote breakdown otherwise.
function quoteFreight({ card, totalWeightKg, parcelCount, dims, dest }) {
  if (!card) return { error: "No rate card selected." };
  if (!(totalWeightKg > 0)) return { error: "Enter a total weight greater than 0 kg." };
  const count = Math.max(1, parcelCount || 1);
  const zoneResult = resolveZone(card, dest);
  if (zoneResult.error) return zoneResult;
  const perParcelWeight = computeChargeableWeightPerParcel({ totalWeightKg, parcelCount: count, dims, card });
  const priceResult = priceForZone(card, zoneResult.zone, perParcelWeight);
  if (priceResult.error) return priceResult;
  const flatSurcharge = Number(card.flatSurcharge) || 0;
  const perParcelCost = priceResult.price + flatSurcharge;
  const expired = !!(card.expiryDate && new Date(card.expiryDate) < new Date());
  return {
    parcelCount: count,
    perParcelWeight,
    weightUnit: card.weightUnit,
    baseCost: priceResult.price,
    flatSurcharge,
    perParcelCost,
    totalCost: perParcelCost * count,
    zone: zoneResult.zone,
    zoneRaw: zoneResult.raw || zoneResult.zone,
    // Not an error — an expired card is still the best estimate available
    // until a fresh one is entered, but the caller should flag it clearly.
    expired,
    expiryDate: card.expiryDate || null,
  };
}

// Browser namespace — app.js calls these as taskG.xxx(...).
if (typeof window !== "undefined") {
  window.taskG = {
    KG_PER_LB, OZ_PER_LB, CM_PER_IN,
    convertWeight, convertLength, volumetricWeight,
    USPS_ZONE_CHARTS, normalizeUspsZone, lookupUspsZone,
    FREIGHT_WAREHOUSES, getWarehouse,
    emptyManualCard, emptyUspsCard, ukRoyalMailCard, ukDpdUkCard, ukDpdNonUkCard, defaultRateCards,
    excelSerialToIsoDate, parseUsToGlobalRateSheet,
    addZone, removeZone, addBracketRow, removeBracketRow,
    computeChargeableWeightPerParcel, priceForZone, resolveZone, quoteFreight,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    KG_PER_LB, OZ_PER_LB, CM_PER_IN,
    convertWeight, convertLength, volumetricWeight,
    USPS_ZONE_CHARTS, normalizeUspsZone, lookupUspsZone,
    FREIGHT_WAREHOUSES, getWarehouse,
    emptyManualCard, emptyUspsCard, ukRoyalMailCard, ukDpdUkCard, ukDpdNonUkCard, defaultRateCards,
    excelSerialToIsoDate, parseUsToGlobalRateSheet,
    addZone, removeZone, addBracketRow, removeBracketRow,
    computeChargeableWeightPerParcel, priceForZone, resolveZone, quoteFreight,
  };
}
