# Demon Bunker: the app's entry. It stays this small and in source: the wedgie's boot loader reads a .py's
# import lines and loads each module with the boot bar filling (it can't read a compiled .mpy's), so the
# seconds of building textures and sprites show as the bar, not a still logo. The game: bunker_game.
import bunker_draw
import bunker_art
import bunker_game
from bunker_game import run
