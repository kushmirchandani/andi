class _F:
    def __getitem__(self, k): return object
Features = _F()
def features(cls):
    class Out:
        def __init__(self, **kw): self.__dict__.update(kw)
    for k in getattr(cls, "__annotations__", {}): setattr(Out, k, object)
    Out.__name__ = cls.__name__
    return Out
