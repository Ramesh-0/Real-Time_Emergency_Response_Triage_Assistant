import json

def prune_records(patient):
    pruned = []

    for record in patient["records"]:
        if (
    record["type"] == "cardiac"
    or (record["severity"] == "high" and int(record["date"]) >= 2022)
):
            pruned.append(record)

    return {
        "patient_id": patient["patient_id"],
        "records": pruned
    }


# TEST RUN
if __name__ == "__main__":
    with open("dataset.json", "r") as f:
        data = json.load(f)

    sample = data[0]

    print("\n--- BEFORE ---")
    print(json.dumps(sample, indent=2))

    pruned = prune_records(sample)

    print("\n--- AFTER ---")
    print(json.dumps(pruned, indent=2))