import zombie_squirrel
from zombie_squirrel.acorns import ACORN_REGISTRY

def _get_columns_for_loader(data_type):
    if data_type not in ACORN_REGISTRY:
        return []
    
    column_func_name = f'{data_type}_columns'
    
    if data_type == 'quality_control':
        column_func_name = 'qc_columns'
    
    if not hasattr(zombie_squirrel, column_func_name):
        print(f'Column function "{column_func_name}" not found in zombie_squirrel')
        return []
    
    try:
        column_func = getattr(zombie_squirrel, column_func_name)
        columns = column_func()
        return columns if columns else []
    except Exception as e:
        print(f'Error getting columns for {data_type}: {e}')
        return []

for loader in ['asset_basics', 'raw_to_derived', 'source_data']:
    cols = _get_columns_for_loader(loader)
    print(f'{loader}: {len(cols)} columns - {cols[:3] if len(cols) > 0 else "[]"}')

print('\nTesting quality_control (should use qc_columns):')
cols = _get_columns_for_loader('quality_control')
print(f'quality_control: returned {len(cols)} columns (may be 0 if S3 data unavailable)')
