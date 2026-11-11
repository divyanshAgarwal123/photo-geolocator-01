# Strategy and reproducibility

The objective is total great-circle distance, rather than a country-label hit
rate. Under the chosen zero-inference constraint, most photographs have too few
machine-readable cues for a precise location. A conservative geographic prior
therefore remains the default. Broad climate cues and yellow lane geometry
occasionally override it. No cue claims to uniquely identify a country.

The decoder is written in this repository and reads image pixels, ignoring EXIF,
comments, file names, hashes and other identity information. Lane scoring uses
fixed perspective sweeps and visible paint/pavement contrast. The geographic
branches are manually chosen rules, not fitted parameters or trained weights.
The evaluation helper and answer files live outside the submitted repository.

Development used practice trial 0. Predictions on trials 1 and 2 were inspected
only after freezing the heuristic. Subsequent changes repaired the harness
entrypoint and API receipt checks; they did not change predicted coordinates.

The entry executes sequentially in manifest order, has no clock-dependent
decisions, uses no random numbers and makes no model requests. It sends all final
coordinates together and confirms that the environment accepted their IDs.
If the decoder cannot read an image, it still supplies the fixed fallback.
Transport/API failures stop the run rather than silently claiming acceptance.

Potential weaknesses include weak geographic information in colour alone,
illumination and seasonal effects, different regional road-paint conventions,
curved or occluded lane lines, and the use of a single fallback over a diverse
world. The 50-photo holdout is small. Its modest aggregate improvement and large
absolute error are reported without a claim about the competition's final rank.
