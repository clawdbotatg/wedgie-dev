import { host } from "./rp2040/chip.mjs";
import { firmware, image } from "./rp2040/image.mjs";
const F = firmware();
const h = host({ fs: image(F, null, {}, ["main.py"]) });
h.until((b) => b.includes(">>> "), 20000);
console.log(h.exec(`
import micropython, array
G = bytearray(4)
@micropython.viper
def f(a: int, b: int) -> int:
    g = ptr8(G)
    g[0] = 7
    c = 0 - a
    n = 0
    while n < 100:
        if n == 5:
            break
        n += 1
    return ((1 << 20) // b) + c + n + g[0] + (c >> 2)
print(f(10, 3), (1<<20)//3 - 10 + 5 + 7 + (-10 >> 2))
`));
