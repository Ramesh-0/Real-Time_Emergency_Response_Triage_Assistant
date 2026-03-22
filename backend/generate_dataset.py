import json
import random

types = ["cardiac", "dental", "dermatology", "orthopedic"]
cardiac_conditions = ["chest pain", "heart palpitations", "ECG abnormal", "high BP", "chest tightness"]
dental_conditions = ["tooth cavity", "tooth extraction", "gum infection"]
skin_conditions = ["acne", "skin allergy", "rash"]
ortho_conditions = ["fracture", "back pain", "joint pain"]

def get_condition(t):
    if t == "cardiac":
        return random.choice(cardiac_conditions)
    elif t == "dental":
        return random.choice(dental_conditions)
    elif t == "dermatology":
        return random.choice(skin_conditions)
    else:
        return random.choice(ortho_conditions)

data = []

for i in range(1, 151):  # 150 patients
    records = []
    
    for _ in range(random.randint(3,5)):
        t = random.choice(types)
        
        record = {
            "condition": get_condition(t),
            "type": t,
            "severity": random.choice(["low", "medium", "high"]),
            "date": str(random.randint(2010, 2025))
        }
        
        records.append(record)

    data.append({
        "patient_id": f"P{str(i).zfill(3)}",
        "records": records
    })

with open("dataset.json", "w") as f:
    json.dump(data, f, indent=2)

print("dataset.json created ✅")