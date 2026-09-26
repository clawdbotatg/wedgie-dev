# Runs before main.py. The boot logo goes up first, before anything slow loads.
try:
    import splash
    splash.show()
except Exception as e:
    print("splash:", e)
