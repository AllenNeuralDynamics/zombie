
import param


class Settings(param.Parameterized):

    def __init__(self, **params):
        super().__init__(**params)


settings = Settings()
