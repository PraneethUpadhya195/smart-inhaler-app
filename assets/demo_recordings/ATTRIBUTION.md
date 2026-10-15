# Demo recordings: source and licence

The eight WAV files in this folder are unmodified copies of recordings from:

> Stavros Nousias, Gerasimos Arvanitis, Aggeliki Anastasiou, Konstantinos Moustakas,
> "Respiratory and Drug Actuation Dataset", IEEE Dataport, March 2, 2022,
> doi: [10.21227/g84h-ma24](https://doi.org/10.21227/g84h-ma24)

**Licence:** [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)](https://creativecommons.org/licenses/by-nc-nd/4.0/)

- **Unmodified:** each file is byte-identical to the dataset file named below; only the file name was changed. The SHA-256 values are also checked by `services/test_sessions.js` (test 15).
- **NonCommercial:** the recordings, and any build of the app that bundles them, may not be used for commercial purposes.
- **NoDerivatives:** do not distribute edited, trimmed, resampled or otherwise modified versions of these files.
- **No endorsement:** the dataset's authors are not affiliated with PRISM and do not endorse it.
- **Scope:** this licence covers these eight recordings only, not the rest of the repository.

The app analyses a randomly chosen file when "Analyse Demo Recording" is tapped (`services/demoRecordings.js`, `services/demoSession.js`).

| File | Dataset recording | SHA-256 |
|---|---|---|
| `demo_01.wav` | `rec2018-01-23_11h00m14.641s.wav` | `66b67d3ae138c52e0c6f3108f71fd3ebf86b47179cd5e9a5fde865b9eb8209f7` |
| `demo_02.wav` | `rec2018-01-23_12h57m37.371s.wav` | `184f384d3b73ffc3bc71d1830c997ef683c4b7fb537c2c92e5d45fc1d2c61e23` |
| `demo_03.wav` | `rec2018-02-05_10h54m35.447s.wav` | `b1943b88c9bdbe1416374c9a6ec7867f11a4341b87aa31c7a6a5e07336634564` |
| `demo_04.wav` | `rec2018-02-05_10h58m35.817s.wav` | `873491f91f0368b9017b5c72af24bcdf3b011ae961501d7471dc83718844b981` |
| `demo_05.wav` | `rec2018-02-06_10h28m57.917s.wav` | `bb9432ffaf4cfc511d723aecdd7caa54ec77a3131ae83696444e771d8a06ea01` |
| `demo_06.wav` | `rec2018-05-03_11h43m36.628s.wav` | `bb7d411945ddf1c748701b202e9911bff3ca55624e978147f8da368c8a056253` |
| `demo_07.wav` | `rec2018-05-03_15h31m15.084s.wav` | `cbc8fa5173c88674d3df6bd8217836d238d6f6473d3c90179cf0fd12cb5b6384` |
| `demo_08.wav` | `rec2018-05-03_15h44m07.780s.wav` | `cd170d88f3a46fbdfc0814a8cb0edbc0b3028a038f66e37f3ccd90b75086605b` |
