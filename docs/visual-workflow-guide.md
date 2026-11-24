# Visual experiment guide (2026-11-24)

`apps/web/workflow/index.html` presents the circuit-to-experiment workflow using an
interactive five-stage diagram, a cropped real workbench screenshot, redrawn testbench
connections and seven native-data plots. The ten-stage contract/source reference remains
in an expandable section with its original historical snapshot identity.

The Bootstrap examples compare a separate sample FET's multi=1 and multi=16 at 1 GS/s,
with the same DUT and 100 fF load. Spectra use 4,096 samples, rectangular window, bin 1811
and a 0.45 V peak full-scale reference. Reproduce SNDR and SFDR with NumPy:

```bash
python tools/dev/verify_showcase.py apps/web/workflow/showcase-samples.json
```

CMOS inverter plots cover transient, DC transfer and AC gain at a 0.435 V bias.
Input/archive hashes are in `showcase-evidence.json`. Private paths, original archives,
PDK files and chat content are excluded. The screenshot shows a different PIPETISAR
workbench as a UI example, clearly captioned.

The three runs were separate Runner reruns. They do not prove completion of the original
onboarding approval or the full Agent workflow. Equivalent bits from sample-and-hold
SNDR are not a complete ADC result; thermal noise, PVT and extracted layout remain outside
this evidence. AC voltage gain is not presented as feedback-loop phase margin.

Static assets are copied by the existing web and Pages builders; no backend restart,
model call or simulation submission is needed to view the guide.
