# Wedgie lore

## Why it's called a wedgie

A wedgie is a Raspberry Pi Pico with a hat on it: the Waveshare Pico-LCD-1.3, a screen with a
joystick and four buttons. The Pico plugs straight into the hat's header. Nothing is soldered.

Then comes the wedge. A secure crypto chip talks to the Pico on the I²C bus, and there is no socket
for it. So we **wedge** it in:

1. The chip's four-wire I²C cable has bare ends. Those wires get **wedged into the hat's header**,
   in the same holes as the Pico's own pins. The header's spring contacts grip the Pico pin and the
   wire together.
2. The chip itself, on its little breakout board, gets **wedged into the gap between the two
   boards**, the Pico underneath and the hat on top.

Two boards, a chip wedged in between, wires wedged into the header. That's a wedgie.

## Give yourself a wedgie

"Wedgie" is a noun and a verb. You can give yourself a wedgie (build one), or give someone else a
wedgie (send them one). Every piece is MIT: print the case, buy the parts, make your own.

## Nobody can tell you ordered a crypto wallet

A wedgie is three ordinary parts from any electronics shop or Amazon: a dev board, a screen, and a
chip. None of them is "a hardware wallet", so buying them says nothing about what you're building.
It only becomes a wallet, a game, or anything else when you plug it in and put software on it.

## The waistband is the button column

The logo is a pair of white briefs with three waistband stripes: green, grey, red. Read the
wedgie's buttons from top to bottom and you get the same thing: A has a green cap, B and X are
grey, Y has a red cap. Green is yes, red is no.

## The first boot screen

The wedgie boots to the underwear and a plastic loading bar that fills grey and turns green. The
website boots to exactly the same picture. The device came first (picowallet's `splash.py` and
`loader.py`); the site copies it.

## Where it came from

The wedgie grew out of picowallet (github.com/austintgriffith/picowallet): a stablecoin hardware
wallet from three Amazon parts, first sending 69 USDS on Ethereum mainnet on 2026-09-05. The
secure chip lived in the gap between the boards from the first day. The case was designed from
scratch, measured with calipers and a flatbed scanner, and iterated on a 3D printer
(github.com/clawdbotatg/clawd-pico-case). The header the wires wedge into is the same 0.1-inch
"Berg strip" electronics have used since the 1950s; that's why the jumper wires are often called
DuPont wires (DuPont bought Berg).

## Trust the order, not the colors

On 2026-09-14 the chip wouldn't answer for four hours. The cable was fine, the chip was fine, the
board was fine. That bag of cables colored the wires white, yellow, black, red instead of Adafruit's
black, red, blue, yellow, and the wires went in by color. The clock wire sat on 3.3 V, the chip
powered itself through its clock pin's protection diode, and the power LED lit, which made it look
like the wiring was right and something was shorted. Two wire moves fixed it.

The plug on every STEMMA QT / Qwiic cable runs **GND, V+, SDA, SCL** from one end. Find the GND
end and count. Never go by color.
