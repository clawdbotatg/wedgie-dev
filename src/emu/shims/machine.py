# The virtual wedgie's stand-in for MicroPython's rp2 `machine` module (from picowallet's emu, MIT).
# Everything goes through `_emu`, the JS bridge registered by src/emu/runtime.ts. Only what the
# wedgie firmware and apps use; unknown things are no-ops rather than errors.
import _emu
import time as _time

_out = {}
_seq = [0]


class Pin:
    IN = 0
    OUT = 1
    OPEN_DRAIN = 2
    ALT = 3
    PULL_UP = 1
    PULL_DOWN = 2
    IRQ_RISING = 1
    IRQ_FALLING = 2

    def __init__(self, id, mode=-1, pull=-1, value=None, **kw):
        self.id = id
        _seq[0] += 1
        self._t = _seq[0]       # this Pin object: each one sees every key press at least once
        self._mode = mode
        if value is not None:
            _emu.pin_write(id, 1 if value else 0)
        elif mode == Pin.OUT and id not in _out:
            _emu.pin_write(id, 0)
        if mode == Pin.OUT:
            _out[id] = True

    def init(self, mode=-1, pull=-1, value=None, **kw):
        self.__init__(self.id, mode, pull, value)

    def value(self, v=None):
        if v is None:
            return _emu.pin_read(self.id, self._t)
        _emu.pin_write(self.id, 1 if v else 0)

    def __call__(self, v=None):
        return self.value(v)

    def on(self):
        self.value(1)

    def off(self):
        self.value(0)

    high = on
    low = off

    def toggle(self):
        self.value(0 if self.value() else 1)

    def irq(self, handler=None, trigger=IRQ_FALLING | IRQ_RISING, **kw):
        _emu.pin_irq(self.id, handler, trigger, self)
        return self

    def __repr__(self):
        return "Pin(%r)" % (self.id,)


class SPI:
    MSB = 0
    LSB = 1

    def __init__(self, id=0, baudrate=1_000_000, **kw):
        self.id = id
        self.baudrate = baudrate
        _emu.spi_init(id, baudrate)

    def init(self, baudrate=None, **kw):
        if baudrate:
            self.baudrate = baudrate
            _emu.spi_init(self.id, baudrate)

    def deinit(self):
        pass

    def write(self, buf):
        import uctypes
        _emu.spi_write(self.id, uctypes.addressof(buf), len(buf))

    def read(self, n, write=0):
        return bytes(n)

    def readinto(self, buf, write=0):
        pass

    def write_readinto(self, wbuf, rbuf):
        self.write(wbuf)


class I2C:
    """No chip on the bus in the emulator: every transfer fails with ENODEV, so
    signer.load() falls back to the software key, same as a bare Pico."""

    def __init__(self, id=0, **kw):
        self.id = id

    def scan(self):
        return []

    def _fail(self, *a, **k):
        raise OSError(19, "ENODEV: no I2C device in the emulator")

    writeto = readfrom = readfrom_into = writevto = readfrom_mem = writeto_mem = _fail


SoftI2C = I2C


class PWM:
    def __init__(self, pin, freq=None, duty_u16=None, **kw):
        self.pin = pin
        self._freq = freq or 1000
        self._duty = 0
        if duty_u16 is not None:
            self.duty_u16(duty_u16)

    def freq(self, f=None):
        if f is None:
            return self._freq
        self._freq = f

    def duty_u16(self, d=None):
        if d is None:
            return self._duty
        self._duty = d
        _emu.pwm(self.pin.id, d / 65535)

    def duty_ns(self, ns=None):
        if ns is None:
            return int(self._duty / 65535 * 1e9 / self._freq)
        self.duty_u16(int(ns * self._freq / 1e9 * 65535))

    def deinit(self):
        _emu.pwm(self.pin.id, 0)


class ADC:
    CORE_TEMP = 4

    def __init__(self, pin, **kw):
        self.id = pin.id if isinstance(pin, Pin) else pin

    def read_u16(self):
        return _emu.adc_read(self.id)

    def read_uv(self):
        return self.read_u16() * 3300000 // 65535


class Timer:
    ONE_SHOT = 0
    PERIODIC = 1

    def __init__(self, id=-1, **kw):
        self.id = id
        self._h = None
        if kw:
            self.init(**kw)

    def init(self, mode=PERIODIC, period=-1, freq=None, callback=None, tick_hz=1000, **kw):
        self.deinit()
        if freq:
            period = int(1000 / freq)
        if period < 0:
            period = 1000
        if callback is None:
            return
        self._h = _emu.timer_start(callback, period, mode == Timer.PERIODIC, self)

    def deinit(self):
        if self._h is not None:
            _emu.timer_stop(self._h)
            self._h = None

    def __repr__(self):
        return "Timer(%r)" % (self.id,)


class WDT:
    def __init__(self, id=0, timeout=5000):
        pass

    def feed(self):
        pass


class RTC:
    def datetime(self, dt=None):
        if dt is None:
            t = _time.localtime()
            return (t[0], t[1], t[2], t[6], t[3], t[4], t[5], 0)


class UART:
    def __init__(self, *a, **k):
        pass

    def write(self, b):
        return len(b)

    def read(self, n=-1):
        return None

    def any(self):
        return 0


def freq(*a):
    """freq() -> cpu Hz. freq(cpu[, peri]) sets them; peri raises the SPI cap like on rp2."""
    if a:
        _emu.set_freq(a[0], a[1] if len(a) > 1 else 0)
    return 150_000_000


def reset():
    _emu.reset()


def soft_reset():
    _emu.reset()


def bootloader(*a):
    _emu.reset()


def unique_id():
    return bytes(_emu.uid())


def idle():
    pass


def lightsleep(ms=None):
    if ms:
        _time.sleep_ms(ms)


def deepsleep(ms=None):
    lightsleep(ms)


def disable_irq():
    return 0


def enable_irq(state=0):
    pass


def reset_cause():
    return 1


PWRON_RESET = 1
WDT_RESET = 3
