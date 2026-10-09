// /build: pick a wedgie — its app, its Pico, up to two I2C boards wedged inside, the color of every printed part —
// and the URL becomes that wedgie (/build?app=buttons&pico=nulllab&chip=atecc&chip2=none&lid=white&...). Anyone with the link
// sees the same one and can buy it or build it from the list below. The price is its parts plus $30. Firmware is always the latest.
import "./build.css";
import { esc } from "../ui/device";
import { place3D } from "../ui/place3d";
import { miniCart } from "../ui/cart";
import { firmwareManifest, type Cart, type Manifest } from "../serial/install";
import type { Wedgie3D } from "../ui/wedgie3d";

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";

// Filament you can get on Amazon in a couple of days (1.75 mm, 1 kg, from at least two of the big brands:
// Elegoo, Sunlu, Overture, Polymaker, eSun, Jayo, Hatchbox, Amazon Basics, Creality; checked 2026-09).
// The case is PETG only; buttons and the joystick can be PETG or PLA. hex: how the printed plastic looks.
type Color = { name: string; hex: number; petg?: string; pla?: string };   // petg/pla: where to buy it
const AMZ = "https://www.amazon.com/";
const COLORS: Record<string, Color> = {
  white: { name: "White", hex: 0xefefea, petg: AMZ + "dp/B0D24YS31F", pla: AMZ + "s?k=elegoo+pla+white+1kg" },
  black: { name: "Black", hex: 0x1c1c1e, petg: AMZ + "dp/B0D41Y3WWZ", pla: AMZ + "dp/B09WW4Z413" },
  grey: { name: "Grey", hex: 0x9a9da1, petg: AMZ + "dp/B07PFS4J97", pla: AMZ + "dp/B07HHFXYPS" },
  darkgrey: { name: "Dark grey", hex: 0x4a4d52, petg: AMZ + "dp/B0CB8DRBL2" },
  silver: { name: "Silver", hex: 0xa8abaf, pla: AMZ + "dp/B0DGQ8ZHFS" },
  red: { name: "Red", hex: 0xc0282d, petg: AMZ + "dp/B0DQTXX4D5", pla: AMZ + "dp/B00J0GO8I0" },
  orange: { name: "Orange", hex: 0xe86a2c, petg: AMZ + "dp/B0FS1DC7RJ", pla: AMZ + "dp/B0D421ZH2W" },
  yellow: { name: "Yellow", hex: 0xf0c020, petg: AMZ + "dp/B0D41ZWK7V", pla: AMZ + "s?k=sunlu+pla+yellow+1kg" },
  green: { name: "Green", hex: 0x3c8f3a, petg: AMZ + "dp/B0991YSBDG", pla: AMZ + "dp/B07D69XD89" },
  olive: { name: "Olive", hex: 0x6b6e3a, petg: AMZ + "dp/B0DPZ3DYH1", pla: AMZ + "dp/B0991QGSPS" },
  mint: { name: "Mint", hex: 0x9cd6be, pla: AMZ + "dp/B0B1ZVN853" },
  skyblue: { name: "Sky blue", hex: 0x5aaedc, pla: AMZ + "dp/B0C6QD6456" },
  blue: { name: "Blue", hex: 0x1f4e9e, petg: AMZ + "dp/B0873BC9SY", pla: AMZ + "s?k=sunlu+pla+klein+blue+1kg" },
  darkblue: { name: "Dark blue", hex: 0x1f2a5c, pla: AMZ + "s?k=elegoo+pla+dark+blue+1kg" },
  purple: { name: "Purple", hex: 0x633c94, petg: AMZ + "dp/B07VSVG61K", pla: AMZ + "dp/B0C6QBZ78R" },
  pink: { name: "Pink", hex: 0xeda0bc, petg: AMZ + "dp/B0DN4PJF61", pla: AMZ + "dp/B0GTZS6MGB" },
  magenta: { name: "Magenta", hex: 0xb8237a, pla: AMZ + "s?k=overture+pla+magenta+1kg" },
  beige: { name: "Beige", hex: 0xd8c6a4, petg: AMZ + "dp/B0D41ZTKKD", pla: AMZ + "dp/B0FZVDPLTY" },
  brown: { name: "Brown", hex: 0x6a4a35, petg: AMZ + "dp/B0D421TTJJ", pla: AMZ + "s?k=hatchbox+pla+brown+1kg" },
  clear: { name: "Clear", hex: 0xdde6e8, petg: AMZ + "dp/B0D9VWZWC4" },
};
// Printed parts: URL key, 3D part, label, its STL. case: PETG only.
const PARTS = [
  { key: "lid", part: "lid", name: "Lid", stl: "lid.stl", def: "white", case: true },
  { key: "base", part: "base", name: "Base", stl: "base.stl", def: "black", case: true },
  { key: "a", part: "A", name: "A button", stl: "button.stl", def: "green", case: false },
  { key: "b", part: "B", name: "B button", stl: "button.stl", def: "darkgrey", case: false },
  { key: "x", part: "X", name: "X button", stl: "button.stl", def: "darkgrey", case: false },
  { key: "y", part: "Y", name: "Y button", stl: "button.stl", def: "red", case: false },
  { key: "stick", part: "joystick", name: "Joystick", stl: "joystick.stl", def: "darkgrey", case: false },
] as const;
const fits = (p: { case: boolean }, c: Color) => !!c.petg || (!p.case && !!c.pla);
const DEF_APP = "buttons";
// Pico boards that fit today's case (made for the pink NULLLAB board; see docs/BUILD-ROADMAP.md for the
// ones that don't yet). price: one board, from the cheapest multipack. tested: fit-tested in the case.
const PICOS = [
  { key: "nulllab", name: "Pink USB-C Pico (NULLLAB)", about: "RP2040, 2 MB, headers soldered. The board the case was made for.", tested: true, price: 6.90,
    buy: [["https://www.amazon.com/dp/B0GL1D8RWX", "Amazon 2-pack"], ["https://www.amazon.com/dp/B0GQRMVT4P", "Amazon single"]] },
  { key: "digishuo", name: "Pink USB-C Pico (DIGISHUO)", about: "RP2040, 2 MB. Looks like the same board; headers to solder.", tested: false, price: 5.65,
    buy: [["https://www.amazon.com/dp/B0CDLDTV19", "Amazon 2-pack"]] },
  { key: "green", name: "Green USB-C Pico", about: "RP2040, 2 MB. Same layout as the official Pico, USB-C.", tested: false, price: 5.33,
    buy: [["https://www.amazon.com/dp/B0H5VJM2PM", "Amazon 3-pack"], ["https://www.amazon.com/dp/B0FXWXFMP6", "Amazon single"]] },
];
const picoOf = (k: string) => PICOS.find((p) => p.key === k);
// The price: every part at what it costs us, plus a flat $30 for putting it together and shipping it.
const MARKUP = 30;
const COST = { hat: 13.19, cable: 0.95, petg: 14 / 1000, pla: 13 / 1000 };   // $ each, filament $ per gram
const GRAMS: Record<string, number> = { lid: 11, base: 15, stick: 0.2, a: 0.1, b: 0.1, x: 0.1, y: 0.1 };   // from the STLs
// Boards that fit the wedge: I2C, no bigger than the ATECC608 breakout (25.4 x 17.8 mm; a millimetre more
// and it won't go between the Pico and the hat). Two can chain (each has a spare STEMMA QT port).
// key: in the URL. chip: the name carts.json's "chip" uses. addr: its I2C addresses (two on one bus can't share).
type Chip = { key: string; name: string; group: string; about: string; addr: number[]; price: number; buy: string[][]; chip?: string };
const CHIPS: Chip[] = [
  { key: "trustm", chip: "OPTIGA Trust M", name: "Trust M", group: "Secure chip", about: "Adafruit Infineon OPTIGA Trust M breakout (4351). Keeps keys; the Safe signer uses it.", addr: [0x30], price: 4.95,
    buy: [["https://www.adafruit.com/product/4351", "Adafruit"], ["https://www.amazon.com/s?k=adafruit+optiga+trust+m", "Amazon"], ["https://www.digikey.com/en/products/result?keywords=adafruit%204351", "DigiKey"]] },
  { key: "atecc", chip: "ATECC608", name: "ATECC608", group: "Secure chip", about: "Adafruit ATECC608 breakout (4314). Keeps keys.", addr: [0x60], price: 4.95,
    buy: [["https://www.adafruit.com/product/4314", "Adafruit"], ["https://www.amazon.com/s?k=adafruit+4314+ATECC608", "Amazon"], ["https://www.digikey.com/en/products/detail/adafruit-industries-llc/4314/10419053", "DigiKey"]] },
  ...board("Motion", `
    lis3dh    LIS3DH accelerometer        A 2809      18     4.95  3-axis, tap detection
    msa311    MSA311 accelerometer        A 5309      62     4.50  the cheapest 3-axis
    adxl343   ADXL343 accelerometer       A 4097      53     5.95  3-axis, tap and free-fall
    adxl375   ADXL375 high-g accelerometer A 5374     53     24.95 up to 200 g
    lis331    LIS331 accelerometer        A 4626      18     10.95 up to 24 g
    lsm6ds3   LSM6DS3TR-C IMU             A 4503      6a     9.95  accelerometer + gyro
    mpu6050   MPU-6050 IMU                A 3886      68     12.95 accelerometer + gyro
    icm20948  ICM-20948 9-DoF             A 4554      69     19.95 accelerometer + gyro + compass
    sox9dof   LSM6DSOX + LIS3MDL 9-DoF    A 4517      6a,1c  19.95 accelerometer + gyro + compass
    ds39dof   LSM6DS3TR-C + LIS3MDL 9-DoF A 5543      6a,1c  19.95 accelerometer + gyro + compass
    lsm303    LSM303AGR                   A 4413      19,1e  12.50 accelerometer + compass
    lis3mdl   LIS3MDL magnetometer        A 4479      1c     9.95  3-axis magnetic field
    lis2mdl   LIS2MDL magnetometer        A 4488      1e     7.95  3-axis magnetic field
    mmc5603   MMC5603 magnetometer        A 5579      30     5.95  3-axis magnetic field
    qmc5883   QMC5883P compass            A 6388      2c     5.95  a cheap compass
    tlv493d   TLV493D magnetometer        A 4366      5e     5.95  3D magnetic field
    mlx90393  MLX90393 magnetometer       A 4022      18     9.95  wide-range magnetic field
    tmag5273  TMAG5273 Hall sensor        A 6489      35     5.95  3D magnet position
    as5600    AS5600 angle sensor         A 6357      36     5.95  the angle of a magnet
    ism330    ISM330DHCX IMU (Micro)      S SEN-20176 6b     26.50 industrial accelerometer + gyro
    lsm6dsv   LSM6DSV16X IMU (Micro)      S SEN-21336 6b     25.50 accelerometer + gyro, sensor fusion
    bmi270    BMI270 IMU (Micro)          S SEN-22398 68     17.58 low-power accelerometer + gyro, gestures
    bma400    BMA400 accelerometer (Micro) S SEN-21207 14    10.50 ultra-low-power 3-axis
    mmc5983   MMC5983MA magnetometer (Micro) S SEN-19921 30  18.50 precision magnetic field`),
  ...board("Air and temperature", `
    sht40     SHT40 temp + humidity       A 4885      44     5.95  temperature and humidity
    sht45     SHT45 temp + humidity       A 5665      44     12.50 precision temperature and humidity
    sht31     SHT31-D temp + humidity     A 2857      44     13.95 temperature and humidity
    shtc3     SHTC3 temp + humidity       A 4636      70     6.95  cheap temperature and humidity
    aht20     AHT20 temp + humidity       A 4566      38     4.50  cheap temperature and humidity
    htu31     HTU31 temp + humidity       A 4832      40     6.95  temperature and humidity, with a heater
    hts221    HTS221 temp + humidity      A 4535      5f     9.95  temperature and humidity
    bme280    BME280                      A 2652      77     14.95 temperature, humidity, pressure
    bme688    BME688                      A 5046      77     19.95 temperature, humidity, pressure, gas
    bme680    BME680                      A 3660      77     18.95 temperature, humidity, pressure, gas
    bmp388    BMP388 barometer            A 3966      77     9.95  precision pressure and altitude
    bmp580    BMP580 barometer            A 6411      47     7.95  pressure and altitude
    bmp581    BMP581 barometer            A 6407      47     9.95  precision pressure and altitude
    spa06     SPA06-003 barometer         A 6420      77     4.95  cheap pressure and temperature
    lps22     LPS22 barometer             A 4633      5d     6.95  pressure
    lps25     LPS25 barometer             A 4530      5d     9.95  pressure
    lps28     LPS28DFW barometer          A 6067      5c     12.50 water-resistant pressure
    ms8607    MS8607                      A 4716      76,40  14.95 pressure, humidity, temperature
    mcp9808   MCP9808 thermometer         A 5027      18     4.95  temperature to 0.25 °C
    tmp117    TMP117 thermometer          A 4821      48     11.50 temperature to 0.1 °C
    tmp119    TMP119 thermometer          A 6482      48     14.95 temperature to 0.03 °C
    pct2075   PCT2075 thermometer         A 4369      37     4.95  cheap temperature
    mlx90632  MLX90632 IR thermometer     A 6403      3a     17.50 temperature of what it points at
    sgp30     SGP30 air quality           A 3709      58     17.50 VOC and eCO2
    sgp40     SGP40 air quality           A 4829      59     14.95 VOC index
    sgp41     SGP41 air quality           A 6455      59     19.95 VOC and NOx index
    ens160    ENS160 air quality          A 5606      53     21.95 air quality (gas)
    stcc4     STCC4 CO2 + SHT41           A 6478      64,44  27.50 real CO2, temperature, humidity
    stts22h   STTS22H thermometer (Micro) S SEN-21273 3c     8.53  precise temperature`),
  ...board("Light and distance", `
    veml7700  VEML7700 light              A 4162      10     4.95  brightness (lux)
    bh1750    BH1750 light                A 4681      23     4.50  brightness (lux)
    ltr329    LTR-329 light               A 5591      29     4.50  brightness (lux)
    ltr390    LTR390 UV + light           A 4831      53     4.95  UV and brightness
    tsl2591   TSL2591 light               A 1980      29,28  6.95  high-range brightness
    max44009  MAX44009 light              A 6498      4a     12.50 brightness up to 188k lux
    tsl2585   TSL2585 UV + light          A 6524      39     7.50  UVA and brightness
    as7341    AS7341 color                A 4698      39     18.95 10-channel color
    as7343    AS7343 color                A 6477      39     19.95 14-channel color
    tcs3448   TCS3448 color               A 6525      59     19.95 14-channel color
    tcs3430   TCS3430 color               A 6479      39     9.50  XYZ color
    opt4048   OPT4048 color               A 6335      44     9.95  XYZ color and lux
    apds9960  APDS9960 gesture            A 3595      39     7.50  gesture, proximity, color
    apds9999  APDS9999 proximity          A 6461      52     7.50  proximity, lux, color
    vcnl4040  VCNL4040 proximity          A 4161      60     5.95  proximity and lux
    vcnl4020  VCNL4020 proximity          A 5810      13     5.95  proximity and light
    vcnl4200  VCNL4200 proximity          A 6064      51     6.95  long-range proximity
    vl53l0x   VL53L0X laser distance      A 3317      29     14.95 distance to 1 m
    vl53l1x   VL53L1X laser distance      A 3967      29     14.95 distance to 4 m
    vl53l4cd  VL53L4CD laser distance     A 5396      29     14.95 distance to 1.3 m
    vl53l4cx  VL53L4CX laser distance     A 5425      29     14.95 distance to 6 m
    vl6180x   VL6180X laser distance      A 3316      29     13.95 short distance and lux
    tmf8801   TMF8801 laser distance      A 6522      41     9.95  distance to 2.5 m
    sths34    STHS34PF80 presence         A 6426      5a     14.95 a person nearby (IR)
    vl53l5cx  VL53L5CX 8x8 distance (Mini) S SEN-19013 52    25.95 an 8x8 grid of distances`),
  ...board("Other", `
    eeprom    24LC32 EEPROM               A 5146      50     3.95  4 KB of memory
    drv2605   DRV2605L haptic driver      A 2305      5a     7.95  buzzes a small vibration motor
    ads1115   ADS1115 ADC                 A 1085      48     14.95 reads 4 voltages, 16-bit`),
];
// One board per line: key, name, A(dafruit)/S(parkFun) + its product number, hex I2C addresses, price ($), what it does.
function board(group: string, rows: string): Chip[] {
  return rows.trim().split("\n").map((l) => {
    const [, key, name, shop, id, addr, price, does] = l.trim().match(/^(\S+)\s+(.+?)\s+([AS]) (\S+)\s+([0-9a-f,]+)\s+([0-9.]+)\s+(.+)$/)!;
    const [maker, url] = shop === "A" ? ["Adafruit", `https://www.adafruit.com/product/${id}`] : ["SparkFun", `https://www.sparkfun.com/catalogsearch/result/?q=${id}`];
    return { key, name, group, about: `${maker} ${name} (${id}): ${does}.`, addr: addr.split(",").map((a) => parseInt(a, 16)), price: +price, buy: [[url, maker]] };
  });
}
const GROUPS = [...new Set(CHIPS.map((c) => c.group))];
const chipOf = (key: string) => CHIPS.find((c) => c.key === key);
// What each app looks like on the preview's screen.
const SCREENS: Record<string, string[]> = {
  buttons: ["buttons"], hello: ["hello"], keytest: ["buttons"], demo: ["demo", "demo-2"], mock: ["wallet-home", "wallet-chart", "wallet-send", "wallet-receive"],
  wire_demo: ["clear-sign"], usbwallet: ["wallet-home", "wallet-send", "wallet-signing", "wallet-receive"],
};
// Ready-made wedgies: each is just a /build link, like any shared one.
const PRESETS = [
  { name: "Wallet", q: "app=buttons&pico=nulllab&chip=trustm&chip2=none&lid=white&base=black&a=green&b=darkgrey&x=darkgrey&y=red&stick=darkgrey" },
  { name: "Game", q: "app=buttons&pico=nulllab&chip=none&chip2=none&lid=purple&base=black&a=yellow&b=skyblue&x=mint&y=magenta&stick=yellow" },
  { name: "Plain", q: "app=buttons&pico=nulllab&chip=none&chip2=none&lid=white&base=black&a=green&b=darkgrey&x=darkgrey&y=red&stick=darkgrey" },
];

type Build = { app: string; pico: string; chips: string[]; colors: Record<string, string> };   // chips: two CHIPS keys or "none"

function read(carts: Cart[]): Build {
  const q = new URLSearchParams(location.search);
  const a = q.get("app");   // before the app list is in, trust the link
  const app = a && (!carts.length || carts.some((c) => c.mod === a)) ? a : DEF_APP;
  const colors: Record<string, string> = {};
  for (const p of PARTS) { const c = COLORS[q.get(p.key) || ""]; colors[p.key] = c && fits(p, c) ? q.get(p.key)! : p.def; }
  const pico = picoOf(q.get("pico") || "") ? q.get("pico")! : PICOS[0].key;
  return { app, pico, chips: fitChips(carts, app, [q.get("chip") ?? "trustm", q.get("chip2") ?? "none"]), colors };
}
// The app's chip goes in (first slot) if it needs one. Unknown boards, or one whose I2C address the
// other board already uses, come out.
const clash = (x: string, y: string) => !!chipOf(x)?.addr.some((a) => chipOf(y)?.addr.includes(a));
function fitChips(carts: Cart[], app: string, want: string[]) {
  let [one, two] = want.map((k) => (chipOf(k) ? k : "none"));
  const need = CHIPS.find((c) => c.chip && c.chip === carts.find((x) => x.mod === app)?.chip)?.key;
  if (need && one !== need && two !== need) one = need;
  if (clash(one, two)) two = "none";
  return [one, two];
}
// Every choice goes in the URL, defaults too, so a link means the same wedgie if the defaults change.
function query(b: Build) {
  const q = new URLSearchParams({ app: b.app, pico: b.pico, chip: b.chips[0], chip2: b.chips[1] });
  for (const p of PARTS) q.set(p.key, b.colors[p.key]);
  return q.toString();
}

// What it costs, line by line, and the total (rounded up to a whole dollar).
function price(b: Build) {
  const lines: [string, number][] = [[picoOf(b.pico)!.name, picoOf(b.pico)!.price], ["Waveshare Pico-LCD-1.3", COST.hat]];
  for (const c of b.chips.map(chipOf)) if (c) lines.push([`${c.name} + cable`, c.price + COST.cable]);
  const g = (k: string) => GRAMS[k] * (COLORS[b.colors[k]].petg ? COST.petg : COST.pla);
  lines.push([`Filament (${Math.round(Object.values(GRAMS).reduce((a, x) => a + x, 0))} g)`, PARTS.reduce((a, p) => a + g(p.key), 0)]);
  lines.push(["Building and shipping", MARKUP]);
  return { lines, total: Math.ceil(lines.reduce((a, [, x]) => a + x, 0)) };
}
/** The cheapest wedgie: the cheapest board, no chips. */
export const fromPrice = () => price({ app: DEF_APP, pico: [...PICOS].sort((x, y) => x.price - y.price)[0].key, chips: ["none", "none"],
  colors: Object.fromEntries(PARTS.map((p) => [p.key, p.def])) }).total;

const link = (href: string, t: string) => `<a class="btn btn-xs" href="${href}" target="_blank" rel="noopener">${t}</a>`;

export async function build(main: HTMLElement) {
  main.innerHTML = `
  <section class="sec bld">
    <div class="sec-head">
      <span class="kicker">Build a wedgie</span>
      <h2>Make it yours.</h2>
      <p>Pick its app, the chips inside, and the color of every part. The link is this exact wedgie: share it, and anyone can buy one or build one.</p>
      <div class="row bld-presets"><span class="fine">Start from</span>${PRESETS.map((p) => `<a class="btn btn-xs" href="/build?${p.q}" data-q="${p.q}">${p.name}</a>`).join("")}</div>
    </div>
    <div class="bld-grid">
      <div class="bld-look">
        <div class="card bld-stage"><div id="bld-dev"></div></div>
        <div class="card bld-link">
          <p class="fine">This wedgie's link</p>
          <div class="row"><code class="mono" id="bld-url"></code><button class="btn btn-sm btn-green" id="bld-copy">Copy link</button></div>
        </div>
      </div>
      <div class="bld-pick">
        <div class="card"><h3>Software</h3><p class="fine">The one app it boots into. You can swap it any time from Connect.</p><div class="bld-apps" id="bld-apps"><p class="fine">Loading apps…</p></div></div>
        <div class="card"><h3>Chips</h3><p class="fine">Up to two little I2C boards wedged between the Pico and the screen: a secure chip for keys, a sensor, or both. Only the secure chips have drivers built in so far; for a sensor, your app brings its own.</p>
          <div class="bld-slots" id="bld-chip">${[0, 1].map((i) => `<label class="bld-slot"><span class="bld-part">${i ? "Second" : "First"}</span>
            <select data-slot="${i}"><option value="none">Nothing</option>${GROUPS.map((g) => `<optgroup label="${g}">${
              CHIPS.filter((c) => c.group === g).map((c) => `<option value="${c.key}">${c.name}</option>`).join("")}</optgroup>`).join("")}</select></label>`).join("")}
          </div><p class="fine" id="bld-chip-note"></p></div>
        <div class="card"><h3>Colors</h3><p class="fine">Colors you can get on Amazon in a couple of days. The case is PETG; buttons and joystick PETG or PLA.</p><div class="bld-colors" id="bld-colors"></div></div>
        <div class="card"><h3>Board</h3><p class="fine">The Pico: the brain. These fit the case.</p><div class="bld-apps" id="bld-picos"></div></div>
        <div class="card"><h3>Firmware</h3><p class="fine">Always the latest: <b id="bld-fw">…</b>. Every wedgie updates itself from Connect.</p></div>
      </div>
    </div>

    <div class="bld-out">
      <div class="card bld-buy">
        <span class="kicker">Buy this one</span>
        <div class="order-price"><span id="bld-price"></span> <span>shipped</span></div>
        <p>Built, printed in these colors, with <b id="bld-buy-app"></b> on it.</p>
        <table class="bld-cost" id="bld-cost"></table>
        <div class="row">
          <button class="btn btn-green" disabled>Pay with USDC</button>
          <button class="btn" disabled>Pay with card</button>
        </div>
        <p class="fine soon">Checkout opens soon.</p>
      </div>
      <div class="card bld-diy">
        <span class="kicker">Build this one</span>
        <ol class="bld-steps" id="bld-steps"></ol>
      </div>
    </div>
  </section>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => main.querySelector<T>(s)!;
  let m: Manifest | null = null;
  let b: Build = read([]);
  let dev: Wedgie3D | null = null;
  place3D($("#bld-dev"), { fallback: { kind: "off" } }).then((w) => { dev = w; paintDevice(); });

  let shownApp = "";
  function paintDevice() {
    if (!dev) return;
    for (const p of PARTS) dev.setColor(p.part, COLORS[b.colors[p.key]].hex);
    if (shownApp !== b.app) { shownApp = b.app; dev.setScreens((SCREENS[b.app] || ["launcher"]).map((n) => `/screens/${n}.png`), 2600); }
  }

  function set(next: Build) {
    b = next;
    history.replaceState(null, "", "/build?" + query(b));
    paint();
  }

  function paint() {
    const cart = m?.carts.find((c) => c.mod === b.app);
    // Software: every app, as a row of little carts.
    if (m) {
      $("#bld-apps").innerHTML = m.carts.map((c) => `<button class="bld-app${c.mod === b.app ? " on" : ""}" data-app="${esc(c.mod)}" aria-pressed="${c.mod === b.app}">
        ${miniCart(c)}<span><b>${esc(c.name)}</b><span class="fine">${esc(c.about || "")}</span></span></button>`).join("");
      $("#bld-apps").querySelectorAll<HTMLButtonElement>("[data-app]").forEach((x) => (x.onclick = () => {
        const app = x.dataset.app!;
        set({ ...b, app, chips: fitChips(m!.carts, app, b.chips) });
      }));
      $("#bld-fw").textContent = `wedgie ${m.version}`;
    }
    // Chips: a board the other slot's board clashes with can't be picked; the app's own chip is locked in.
    const must = CHIPS.find((c) => c.chip && c.chip === cart?.chip)?.key;
    $("#bld-chip").querySelectorAll<HTMLSelectElement>("select").forEach((sel) => {
      const i = +sel.dataset.slot!, other = b.chips[1 - i];
      sel.value = b.chips[i];
      sel.disabled = !!must && b.chips[i] === must;
      sel.querySelectorAll("option").forEach((o) => (o.disabled = o.value !== "none" && clash(o.value, other)));
      sel.onchange = () => { const c = [...b.chips]; c[i] = sel.value; set({ ...b, chips: fitChips(m?.carts || [], b.app, c) }); };
    });
    const picked = b.chips.map(chipOf).filter((c): c is Chip => !!c);
    $("#bld-chip-note").textContent = [must ? `${cart!.name} needs the ${chipOf(must)!.name}.` : "", ...picked.map((c) => c.about)].filter(Boolean).join(" ");
    // Colors: one row of swatches per part.
    $("#bld-colors").innerHTML = PARTS.map((p) => `<div class="bld-color"><span class="bld-part">${p.name} <span class="fine">${COLORS[b.colors[p.key]].name}</span></span><span class="bld-sw">${
      Object.entries(COLORS).filter(([, c]) => fits(p, c)).map(([k, c]) => `<button class="sw${b.colors[p.key] === k ? " on" : ""}" style="--c:#${c.hex.toString(16).padStart(6, "0")}" data-part="${p.key}" data-color="${k}" title="${c.name}" aria-label="${p.name}: ${c.name}" aria-pressed="${b.colors[p.key] === k}"></button>`).join("")
    }</span></div>`).join("");
    $("#bld-colors").querySelectorAll<HTMLButtonElement>(".sw").forEach((x) => (x.onclick = () => set({ ...b, colors: { ...b.colors, [x.dataset.part!]: x.dataset.color! } })));
    // The link
    const url = `${location.origin}/build?${query(b)}`;
    $("#bld-url").textContent = url;
    $("#bld-buy-app").textContent = cart?.name || b.app;
    // Board
    $("#bld-picos").innerHTML = PICOS.map((p) => `<button class="bld-app${p.key === b.pico ? " on" : ""}" data-pico="${p.key}" aria-pressed="${p.key === b.pico}">
      <span><b>${esc(p.name)}</b> <span class="fine">$${p.price.toFixed(2)} · ${p.tested ? "fit-tested" : "should fit, not tested yet"}</span><span class="fine">${esc(p.about)}</span></span></button>`).join("");
    $("#bld-picos").querySelectorAll<HTMLButtonElement>("[data-pico]").forEach((x) => (x.onclick = () => set({ ...b, pico: x.dataset.pico! })));
    // Price
    const pr = price(b);
    $("#bld-price").textContent = `$${pr.total}`;
    $("#bld-cost").innerHTML = pr.lines.map(([t, x]) => `<tr><td>${esc(t)}</td><td>$${x.toFixed(2)}</td></tr>`).join("");
    const pico = picoOf(b.pico)!;
    // Build it yourself: the parts this one needs, the prints in its colors, then assemble and install.
    const cname = (k: string) => COLORS[b.colors[k]].name;
    // One spool per color: PETG when it comes in PETG (every case color does), else PLA.
    const filament = () => [...new Set(PARTS.map((p) => b.colors[p.key]))]
      .map((k) => { const c = COLORS[k]; return link((c.petg || c.pla)!, `${c.name} ${c.petg ? "PETG" : "PLA"}`); }).join("");
    const buttons = PARTS.filter((p) => p.stl === "button.stl").map((p) => `${p.name[0]} ${cname(p.key).toLowerCase()}`).join(", ");
    $("#bld-steps").innerHTML = `
      <li><b>${esc(pico.name)}</b> <span>${esc(pico.about)}</span>
        <div class="buy">${pico.buy.map(([u, t]) => link(u, t)).join("")}</div></li>
      <li><b>The screen hat</b> <span>Waveshare Pico-LCD-1.3.</span>
        <div class="buy">${link("https://www.amazon.com/dp/B092VVCBQP", "Amazon")}${link("https://www.waveshare.com/pico-lcd-1.3.htm", "Waveshare")}${link("https://thepihut.com/products/1-3-ips-lcd-display-module-for-raspberry-pi-pico-240x240", "The Pi Hut")}</div></li>
      ${picked.map((c, i) => `<li><b>${esc(c.name)}</b> <span>${esc(c.about)} ${i ? "It chains off the first board's spare port: add a 50 mm STEMMA QT cable."
          : "Plus a STEMMA QT / Qwiic cable with bare wire ends."}</span>
        <div class="buy">${c.buy.map(([u, t]) => link(u, t)).join("")}${i ? link("https://www.adafruit.com/product/4399", "50 mm cable") : link("https://www.adafruit.com/product/4209", "Cable")}</div></li>`).join("")}
      ${b.app === "battery" ? `<li><b>A battery hat</b> <span>The Battery app reads a Waveshare Pico-UPS-B.</span>
        <div class="buy">${link("https://www.waveshare.com/pico-ups-b.htm", "Waveshare")}</div></li>` : ""}
      <li><b>Get the filament</b> <span>1.75 mm. The case in PETG; buttons and joystick in PETG or PLA.</span>
        <div class="buy">${filament()}</div></li>
      <li><b>Print the case</b> <span>0.16 mm layers, 4 walls, no supports. Lid in ${cname("lid").toLowerCase()}, base in ${cname("base").toLowerCase()}, joystick in ${cname("stick").toLowerCase()}, buttons: ${buttons}.</span>
        <div class="buy">${[["lid.stl", `Lid · ${cname("lid")}`], ["base.stl", `Base · ${cname("base")}`], ["joystick.stl", `Joystick · ${cname("stick")}`], ["button.stl", "Button ×4"]]
          .map(([f, t]) => `<a class="btn btn-xs" href="${CASE}${f}" download>${t}</a>`).join("")}</div></li>
      <li><b>Put it together</b> <span>${picked.length ? `Wedge the wires in, then the ${picked.length > 1 ? "boards" : "board"}, then the case.` : "Plug the Pico into the hat, then snap the case on. Skip the chip steps."}</span>
        <div class="buy"><a class="btn btn-xs" href="/assemble">Assembly guide</a></div></li>
      <li><b>Put ${esc(cart?.name || b.app)} on it</b> <span>Plug it in, tap Connect at the top, open your wedgie, and tap ${esc(cart?.name || b.app)}. It gets the latest firmware too.</span>
        <div class="buy"><a class="btn btn-xs" href="/connect">Connect</a></div></li>`;
    paintDevice();
  }

  // Presets stay on this page (no reload, no loader).
  main.querySelectorAll<HTMLAnchorElement>("[data-q]").forEach((a) => (a.onclick = (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    history.replaceState(null, "", "/build?" + a.dataset.q);
    set(read(m?.carts || []));
  }));
  $("#bld-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#bld-url").textContent!); $("#bld-copy").textContent = "Copied"; setTimeout(() => ($("#bld-copy").textContent = "Copy link"), 1500); }
    catch { getSelection()?.selectAllChildren($("#bld-url")); }
  };

  paint();
  try { m = await firmwareManifest(); set(read(m.carts)); }
  catch (err) { console.error("build:", err); $("#bld-apps").innerHTML = `<p class="fine">Couldn't load the apps.</p>`; }
}
