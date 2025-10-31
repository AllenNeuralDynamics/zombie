from pydantic import BaseModel, SerializeAsAny, model_validator
from typing import Dict, Any

class GenericModel(BaseModel, extra="allow"):
    
    @model_validator(mode="after")
    def validate_fieldnames(self):
        """Warn users when field names contain forbidden characters
        These characters will cause issues with MongoDB queries
        """
        return self

class MyClass(GenericModel):
    x: int
    y: int

class MyModel(BaseModel):
    data: SerializeAsAny[GenericModel]

# Create an instance of MyClass
obj = MyClass(x=1, y=2)

# Pass the class instance as the value in the dictionary
model = MyModel(data=obj)

# Serialize the model
serialized = model.model_dump()
print("Serialized:", serialized)

# Deserialize the model
deserialized = MyModel.model_validate(serialized)
print("Deserialized:", deserialized)
print("Deserialized dump", deserialized.model_dump())