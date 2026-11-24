"""Initialize the first paired boot after a measured stock activation."""

import os


def activate():
    import paired_bridge as bridge
    from paired_update_boot import _exists, _flash_replace, _flash_write
    from pair_policy import BASELINE_STATE, RELEASE_KEYS
    import wedgie

    if not bridge.versioned() or tuple(wedgie.RELEASE_KEYS) != tuple(RELEASE_KEYS):
        raise ValueError("paired activation trust policy does not match the installed core")
    if _exists(bridge.LIVE + "/_job.json"):
        raise ValueError("pending stock install conflicts with paired activation")
    if _exists(bridge.STATE):
        return bridge.early_boot()
    if _exists(bridge.APPROVED) or _exists(bridge.OFFER) or _exists(bridge.VERSION_RECEIPT):
        raise ValueError("paired state is missing for an existing update or activation")

    # This proves the exact installed serial, active app, and expected
    # baseline bytes before creating any persistent paired state.
    bridge._check_baseline(BASELINE_STATE)
    if not _exists(bridge.ROOT):
        os.mkdir(bridge.ROOT)
    staged_state = bridge.ROOT + "/installed.tmp"
    _flash_write(staged_state, BASELINE_STATE)
    _flash_replace(staged_state, bridge.STATE)
    return None
