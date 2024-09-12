# Create an example quality_control.json file for use
from aind_data_schema_models.modalities import Modality
from aind_data_schema.core.quality_control import (
    QualityControl,
    QCEvaluation,
    QCMetric,
    Stage,
    Status,
)
from pathlib import Path

qc = QualityControl(  # type: ignore
    overall_status=Status.FAIL,
    overall_status_date="2024-08-30",
    evaluations=[
        QCEvaluation(
            evaluation_modality=Modality.ECEPHYS,
            evaluation_stage=Stage.PREPROCESSING,
            evaluation_name="Drift map",
            evaluator="Automated",
            evaluation_date="2024-08-30",
            qc_metrics=[QCMetric(name="Drift map good", value=False)],
            stage_status=Status.FAIL,
        )
    ],
)

qc.write_standard_file(Path("."))
