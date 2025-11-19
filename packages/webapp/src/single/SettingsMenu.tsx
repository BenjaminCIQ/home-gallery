import React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as icons from "@fortawesome/free-solid-svg-icons";
import { useSingleViewStore } from "../store/single-view-store"; // adjust path as needed

/**
 * SettingsMenu
 *
 * Props:
 *  - stopSlideshow: function that stops the slideshow (passed from MediaView)
 *
 * Integrates with useSingleViewStore (Zustand) for these values:
 *  - loopImages, setLoopImages
 *  - shuffleImages, setShuffleImages
 *  - slideshowInterval, setSlideshowInterval (ms)
 *  - slideshowTimeout, setSlideshowTimeout (ms)
 *  - navigationTimeout, setNavigationTimeout (ms)
 *
 * NOTE: This component expects your store to already expose the above selectors.
 */
export const SettingsMenu = ({settingsOpen, setSettingsOpen }) => {
  // Zustand selectors
  const loopImages = useSingleViewStore((s) => s.loopImages);
  const setLoopImages = useSingleViewStore((s) => s.setLoopImages);
  const shuffleImages = useSingleViewStore((s) => s.shuffleImages);
  const setShuffleImages = useSingleViewStore((s) => s.setShuffleImages);
  const resetSearchOnLoopEnd = useSingleViewStore((s) => s.resetSearchOnLoopEnd);
  const setResetSearchOnLoopEnd = useSingleViewStore((s) => s.setResetSearchOnLoopEnd);

  const slideshowInterval = useSingleViewStore((s) => s.slideshowInterval);
  const setSlideshowInterval = useSingleViewStore((s) => s.setSlideshowInterval);
  const slideshowTimeout = useSingleViewStore((s) => s.slideshowTimeout);
  const setSlideshowTimeout = useSingleViewStore((s) => s.setSlideshowTimeout);
  const navigationTimeout = useSingleViewStore((s) => s.navigationTimeout);
  const setNavigationTimeout = useSingleViewStore((s) => s.setNavigationTimeout);

  // your styling system
  const itemClass = "md:opacity-40 hover:opacity-100 hover:cursor-pointer";
  const buttonClass =
    "block flex items-center justify-center rounded w-8 h-8 md:w-12 md:h-12";
  const buttonBgClass = "bg-gray-400/60 md:bg-gray-400/70";
  const iconClass = "md:text-2xl text-gray-800";

  // Handle button click: toggle open and stop slideshow
  const handleToggle = () => {
    const next = !settingsOpen;
    setSettingsOpen(next);
  };

  return (
    <div className="fixed bottom-4 left-4 z-50">
      {/* relative container keeps button in place while popup opens above */}
      <div className="relative">
        {/* Menu button (stays fixed) */}
        <button
          className={`${itemClass} ${buttonClass} ${buttonBgClass}`}
          onClick={handleToggle}
          aria-expanded={settingsOpen}
          aria-label="Open settings"
        >
          <FontAwesomeIcon icon={icons.faBars} className={iconClass} />
        </button>

        {/* Drop-up menu: appears above the button */}
        {settingsOpen && (
          <div
            className="
              absolute bottom-full left-0 mb-3
              w-72 max-w-[90vw]
              bg-gray-300/70 backdrop-blur-md
              text-gray-900
              rounded-xl p-4
              border border-gray-500/20
              shadow-xl
            "
            role="dialog"
            aria-label="Slideshow settings"
          >
            {/* Contents */}
            <div className="space-y-4">
              {/* UnitSlider - Slideshow Interval (minSeconds default to 5s for your case) */}
              <UnitSlider
                label="Slide Interval"
                valueMs={slideshowInterval}
                onChange={(ms) => setSlideshowInterval(ms)}
              />

              {/* UnitSlider - Start Timeout */}
              <UnitSlider
                label="Start Timeout"
                valueMs={slideshowTimeout}
                onChange={(ms) => setSlideshowTimeout(ms)}
                minSeconds={5}
              />

              {/* UnitSlider - Navigation Hide Timeout */}
              <UnitSlider
                label="Navigation Hide"
                valueMs={navigationTimeout}
                onChange={(ms) => setNavigationTimeout(ms)}
              />
              {/* Loop */}
              <RowToggle
                label="Loop Images"
                value={loopImages}
                onToggle={() => setLoopImages(!loopImages)}
              />

              {/* Shuffle */}
              <RowToggle
                label="Shuffle"
                value={shuffleImages}
                onToggle={() => setShuffleImages(!shuffleImages)}
              />

              {/* ResetSearchOnLoopEnd */}
              <RowToggle
                label="Reset Search on LoopEnd"
                value={resetSearchOnLoopEnd}
                onToggle={() => setResetSearchOnLoopEnd(!resetSearchOnLoopEnd)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------------------------
   Small helper components
   ---------------------------*/

/** RowToggle: simple label + toggle button using your grayscale style */
const RowToggle = ({ label, value, onToggle }) => {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm font-medium">{label}</span>
      <button
        onClick={onToggle}
        className={`
          w-12 h-6 rounded-full relative transition
          ${value ? "bg-gray-700/80" : "bg-gray-500/50"}
        `}
        aria-pressed={!!value}
      >
        <div
          className={`
            absolute top-0.5 h-5 w-5 rounded-full bg-white transition
            ${value ? "right-0.5" : "left-0.5"}
          `}
        />
      </button>
    </div>
  );
};

/**
 * UnitSlider
 *
 * - Slider range is 1..60
 * - Unit cycles (SEC -> MIN -> HR) via a single tap button to the right of the slider
 * - The slider's actual min is dynamically computed from minSeconds so the thumb literally can't move below allowed minimum
 *
 * Props:
 *  - label (string)
 *  - valueMs (number)        // current value in milliseconds
 *  - onChange (ms => void)   // receives ms
 *  - minSeconds (number)     // floor, e.g. 5
 */
const UnitSlider = ({ label, valueMs, onChange, minSeconds = 0 }) => {
const units = ["sec", "min", "hr"];

const multipliers = {
    sec: 1000,
    min: 60 * 1000,
    hr: 3600 * 1000,
};

const multipliersSec = {
    sec: 1,
    min: 60,
    hr: 3600,
};

// Detect initial unit based on clean divisibility
const detectUnit = (ms) => {
    if (ms % multipliers.hr === 0) return "hr";
    if (ms % multipliers.min === 0) return "min";
    return "sec";
};

const [unit, setUnit] = React.useState(detectUnit(valueMs));

// Slider number (unit-free)
const sliderValue = Math.round(valueMs / multipliers[unit]);

const calcMinForUnit = (uni: string) => {
    return Math.min(
        60, // maximum slider value
        Math.max(
          1, // minimum slider value
          Math.ceil(minSeconds / multipliersSec[uni])
        )
      );
}

const minForUnit = calcMinForUnit(unit);

// Handle slider change → convert to ms
const handleSliderChange = (e) => {
    const raw = Number(e.target.value);
    const clamped = Math.max(minForUnit, Math.min(60, raw));
    onChange(clamped * multipliers[unit]);
  };

// Cycle unit while keeping slider number the same and above minimum
const cycleUnit = () => {
    const nextUnit = units[(units.indexOf(unit) + 1) % units.length];
    const minForNextUnit = calcMinForUnit(nextUnit);
    const newMs = ((sliderValue < minForNextUnit) ? minForNextUnit : sliderValue) * multipliers[nextUnit];

    setUnit(nextUnit);
    onChange(newMs);
  };
  

// Human-readable display
const displayText = (() => {
    const sec = Math.round(valueMs / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    return `${Math.round(sec / 3600)} hr`;
})();

return (
    <div className="space-y-2">
    {/* label + output */}
    <div className="flex justify-between items-center">
        <label className="font-medium text-sm">{label}</label>
        <span className="text-sm opacity-70">{displayText}</span>
    </div>

    {/* slider + unit button */}
    <div className="flex items-center gap-3">
        <input
        type="range"
        min={1}
        max={60}
        step={1}
        value={sliderValue}
        onChange={handleSliderChange}
        className="w-full"
        />

        <button
        onClick={cycleUnit}
        className="w-16 px-3 py-1 rounded bg-gray-400/60 whitespace-nowrap text-sm text-center"
        aria-label="Change unit"
        >
        {unit.toUpperCase()}
        </button>
    </div>
    </div>
);
};  

export default SettingsMenu;
