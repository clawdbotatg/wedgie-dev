# wedgie firmware. The launcher owns the screen and USB until Ctrl-C (which drops to the REPL, so
# mpremote and wedgie.dev keep working).
import sys
try:
    import lcd          # first: grabs the framebuffer while the heap is fresh (RP2040 boards need this)
    import loader
    loader.load("menu")  # its files load one by one under the boot logo's bar
    import menu
    menu.run()
except KeyboardInterrupt:
    pass
except Exception as e:
    with open("error.log", "w") as f:
        sys.print_exception(e, f)
    sys.print_exception(e)
