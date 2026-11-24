"""Create the disposable CDC + FIDO HID INIT/PING-only Pico UF2 fixture."""

from hashlib import sha256
from pathlib import Path
from struct import pack, unpack_from
from subprocess import run
from sys import executable
from tempfile import TemporaryDirectory
import argparse

from littlefs import LittleFS
import mpy_cross


FLASH = 0x10000000
FILESYSTEM = FLASH + 0xA0000
END = FLASH + 0x200000
FAMILY = 0xE48BFF56
START = (0x0A324655, 0x9E5D5157)
STOP = 0x0AB16F30
PAGE = 256
BLOCK = 512
PROBE_BOOT = """import usbdev
from ctaphid import Transport
from fido_usb import FidoHid
from os import urandom
from time import ticks_diff, ticks_ms

hid = FidoHid(lambda: Transport(lambda: urandom(4), ticks_ms, ticks_diff))
usbdev.get().init(hid, builtin_driver=True, product_str="Wedgie FIDO transport probe")
"""
PROBE_MAIN = """from time import sleep_ms

print("FIDO transport probe ready: INIT/PING only")
while True:
    hid.poll()
    sleep_ms(1)
"""


def pages(uf2, limit):
    if not uf2 or len(uf2) % BLOCK:
        raise ValueError("Invalid UF2 length")
    count = len(uf2) // BLOCK
    seen = set()
    for index in range(count):
        offset = index * BLOCK
        magic0, magic1, flags, address, size, number, total, family = unpack_from("<8I", uf2, offset)
        if ((magic0, magic1) != START or unpack_from("<I", uf2, offset + 508)[0] != STOP
                or flags != 0x2000 or family != FAMILY or size != PAGE
                or number != index or total != count or address in seen
                or address % PAGE or not FLASH <= address <= limit - PAGE):
            raise ValueError(f"Invalid RP2040 UF2 block {index}")
        seen.add(address)
        yield address, uf2[offset + 32:offset + 32 + PAGE]


def make_uf2(image_pages):
    return b"".join(pack("<8I", *START, 0x2000, address, PAGE, number, len(image_pages), FAMILY)
        + data.ljust(476, b"\x00") + pack("<I", STOP)
        for number, (address, data) in enumerate(image_pages))


def main(output):
    lab = Path(__file__).resolve().parent
    repo = lab.parents[1]
    micros = list(pages((repo / "public/mp/RPI_PICO.uf2").read_bytes(), FILESYSTEM))
    with TemporaryDirectory(prefix="fido-probe-") as scratch:
        directory = Path(scratch)
        sources = {"boot.py": PROBE_BOOT.encode(), "main.py": PROBE_MAIN.encode()}
        for name, source in (("usbdev", repo / "firmware/usbdev.py"), ("ctaphid", lab / "ctaphid.py"),
                              ("fido_usb", lab / "fido_usb.py")):
            compiled = directory / f"{name}.mpy"
            run([mpy_cross.mpy_cross, "-s", f"{name}.py", "-o", str(compiled), str(source)], check=True)
            sources[compiled.name] = compiled.read_bytes()
        for name, data in sources.items():
            (directory / name).write_bytes(data)
        image = directory / "filesystem.img"
        run([executable, str(repo / "tools/rp2040/mkfs.py"), str(image),
             *(f"{name}={directory / name}" for name in sources)], check=True)
        fs_image = image.read_bytes()

    if len(fs_image) != END - FILESYSTEM:
        raise ValueError("Unexpected Pico LittleFS size")
    filesystem = [(FILESYSTEM + offset, fs_image[offset:offset + PAGE])
                  for offset in range(0, len(fs_image), PAGE)]
    result = make_uf2(micros + filesystem)
    decoded = list(pages(result, END))
    if decoded != micros + filesystem:
        raise ValueError("UF2 failed round-trip validation")
    fs = LittleFS(mount=False, block_size=4096, block_count=352, prog_size=256)
    fs.context.buffer[:] = b"".join(data for _, data in decoded[len(micros):])
    fs.mount()
    if set(fs.listdir("/")) != set(sources):
        raise ValueError("Unexpected files in the readback")
    for name, data in sources.items():
        with fs.open(name, "rb") as file:
            if file.read() != data:
                raise ValueError(f"LittleFS readback failed for {name}")
    with output.open("xb") as file:
        file.write(result)
    print(f"Verified {len(decoded)} RP2040 blocks and {len(sources)} LittleFS files")
    print(f"SHA-256 {sha256(result).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    main(parser.parse_args().output)
