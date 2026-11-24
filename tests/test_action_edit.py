import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'skills/teach-desktop-pet/scripts/teach.py'


class ActionEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pet = self.root / 'data/pets/lizi'
        self.pet.mkdir(parents=True)
        for n in ('pet.json', 'spritesheet.webp'):
            shutil.copy2(ROOT / 'examples/lizi' / n, self.pet / n)
        self.folder = self.root / 'edit'
        self.env = {**os.environ, 'PET_STUDIO_DATA': str(self.root / 'data')}

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args, ok=True):
        r = subprocess.run([sys.executable, str(SCRIPT), *map(str,args)], env=self.env, text=True, capture_output=True)
        self.assertEqual(r.returncode == 0, ok, r.stderr + r.stdout)
        return r.stdout + r.stderr

    def learn(self, name='dance', frames=4, loop=None):
        """The pet has learned `name`, drawn as a plain strip (plan/29:
        only learned actions can be redrawn)."""
        (self.pet/'custom/assets').mkdir(parents=True, exist_ok=True)
        strip=Image.new('RGBA',(192*frames,208))
        for i in range(frames):strip.paste((80,130,200,255),(i*192+70,80,i*192+110,180))
        strip.save(self.pet/f'custom/assets/{name}.png')
        action={'label':'跳舞','image':f'assets/{name}.png','durations':[140]*(frames-1)+[280]}
        if loop:action['loopFrames']=loop
        layer={'actions':{name:action},'rules':[]}
        (self.pet/'custom/action-library.json').write_text(json.dumps({'revision':9,'layer':layer,'items':[]}))
        return strip, action

    def begin(self, name='dance'):
        return self.cli('new','--pet','lizi','--replace',name,'--dir',self.folder,'--summary','重画跳舞')

    def test_learned_action_exported_attached_and_timings_preserved(self):
        strip, action = self.learn()
        self.begin()
        with Image.open(self.folder/'references/current-action.png') as current:
            self.assertEqual(current.tobytes(), strip.tobytes())
        meta=json.loads((self.folder/'replacement.json').read_text())
        self.assertEqual(meta['baseVersion'],9)
        response=json.loads(self.cli('prompt','--dir',self.folder,'--name','dance','--label','跳舞','--frames',4,'--motion','1-4: dance.'))
        self.assertTrue(any('current-action.png' in r['path'] for r in response['input_images']))
        self.cli('add-action','--dir',self.folder,'--name','dance','--label','跳舞','--strip',self.folder/'references/current-action.png')
        t=json.loads((self.folder/'teaching.json').read_text())
        self.assertEqual(t['actions']['dance']['durations'],action['durations'])
        self.assertEqual(t['replaceActions'],['dance'])
        self.cli('check','--dir',self.folder)
        self.assertTrue((self.folder/'qa/dance-before-after.gif').is_file())
        # The app accepting something newer invalidates this reference.
        library=json.loads((self.pet/'custom/action-library.json').read_text())
        library['revision']=10
        (self.pet/'custom/action-library.json').write_text(json.dumps(library))
        self.cli('check','--dir',self.folder,ok=False)

    def test_ongoing_learned_action_keeps_its_loop(self):
        self.learn('read', frames=6, loop=[2,5])
        self.begin('read')
        self.assertEqual(json.loads((self.folder/'replacement.json').read_text())['loopFrames'],[2,5])
        self.cli('add-action','--dir',self.folder,'--name','read','--label','跳舞','--strip',self.folder/'references/current-action.png','--frames',6,'--loop-frames',2,4,ok=False)
        self.cli('add-action','--dir',self.folder,'--name','read','--label','跳舞','--strip',self.folder/'references/current-action.png','--frames',6)
        t=json.loads((self.folder/'teaching.json').read_text())
        self.assertEqual(t['actions']['read']['loopFrames'],[2,5])
        self.cli('check','--dir',self.folder)

    def test_base_actions_and_sleep_are_refused_before_output_is_created(self):
        self.learn()
        for name in ('idle','running-left','running-right','running','waving','sleep','look-up'):
            self.cli('new','--pet','lizi','--replace',name,'--dir',self.folder,'--summary','改',ok=False)
            self.assertFalse(self.folder.exists())

    def test_corrupt_current_collection_does_not_silently_use_legacy_state(self):
        (self.pet/'custom').mkdir()
        (self.pet/'custom/action-library.json').write_text('{broken')
        self.cli('new','--pet','lizi','--replace','dance','--dir',self.folder,'--summary','改',ok=False)
        self.assertFalse(self.folder.exists())
