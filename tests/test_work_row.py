import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT/'skills/make-desktop-pet/scripts/project.py'
class WorkRowTests(unittest.TestCase):
    def test_experiment_only_changes_work_action_and_can_restore_exact_original(self):
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/'sample'
            subprocess.run([sys.executable,str(PROJECT),'prepare','--run',str(run),'--id','fixture','--name','示例','--notes','圆润的蓝色小机器人','--work-row','original'],check=True,capture_output=True)
            originals={str(p.relative_to(run)):p.read_bytes() for p in (run/'prompts').rglob('*.md')}
            subprocess.run([sys.executable,str(PROJECT),'repair','--run',str(run),'--job','running','--reason','试试学习','--work-row','laptop'],check=True,capture_output=True)
            changed=[]
            for name,data in originals.items():
                if (run/name).read_bytes()!=data:changed.append(name)
            self.assertEqual(sorted(changed),['prompts/row-retries/running.md','prompts/rows/running.md'])
            prompt=(run/'prompts/rows/running.md').read_text()
            self.assertIn('Quiet study loop',prompt)
            self.assertIn('half its own height',prompt)
            self.assertNotIn('cat',prompt.lower().split('state action:')[1].split('state requirements:')[0])
            self.assertEqual(json.loads((run/'pet_request.json').read_text())['work_row'],'laptop')
            subprocess.run([sys.executable,str(PROJECT),'repair','--run',str(run),'--job','running','--reason','回到原版','--work-row','original'],check=True,capture_output=True)
            self.assertEqual((run/'prompts/rows/running.md').read_bytes(),originals['prompts/rows/running.md'])
            self.assertEqual((run/'prompts/row-retries/running.md').read_bytes(),originals['prompts/row-retries/running.md'])
