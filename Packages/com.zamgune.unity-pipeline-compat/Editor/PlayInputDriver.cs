using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;

namespace Zamgune.UnityPipelineCompat
{
    internal sealed class PlayInputDriver : IDisposable
    {
        private readonly Dictionary<Keyboard, HashSet<Key>> _active_keys_by_keyboard =
            new Dictionary<Keyboard, HashSet<Key>>();
        private readonly Dictionary<InputAction, bool> _action_enabled_before =
            new Dictionary<InputAction, bool>();
        private readonly HashSet<InputAction> _actions_to_release = new HashSet<InputAction>();
        private readonly HashSet<InputAction> _press_actions = new HashSet<InputAction>();
        private readonly HashSet<InputAction> _held_actions = new HashSet<InputAction>();
        private readonly List<InputDevice> _reenabled_devices = new List<InputDevice>();
        private readonly List<string> _applied_inputs = new List<string>();
        private readonly List<string> _warnings = new List<string>();

        private bool _prepared;
        private bool _disposed;
        private bool _previous_run_in_background;
        private InputSettings.BackgroundBehavior _previous_background_behavior;
        private InputSettings.EditorInputBehaviorInPlayMode _previous_editor_input_behavior;

        internal IReadOnlyList<string> AppliedInputs => _applied_inputs;
        internal IReadOnlyList<string> Warnings => _warnings;
        internal bool HasPressInputs => _press_actions.Count > 0;

        internal void Prepare()
        {
            if (_prepared)
            {
                return;
            }

            _previous_run_in_background = Application.runInBackground;
            _previous_background_behavior = InputSystem.settings.backgroundBehavior;
            _previous_editor_input_behavior = InputSystem.settings.editorInputBehaviorInPlayMode;
            _prepared = true;

            Application.runInBackground = true;
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            InputSystem.settings.editorInputBehaviorInPlayMode =
                InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;

            foreach (InputDevice device in InputSystem.devices)
            {
                if (device != null && !device.enabled)
                {
                    InputSystem.EnableDevice(device);
                    _reenabled_devices.Add(device);
                }
            }

            ResetAllInputDevices();
        }

        internal void TriggerInputs(
            InputActionAsset asset,
            IReadOnlyList<ZamgunePlayInput> inputs)
        {
            if (inputs == null || inputs.Count == 0)
            {
                return;
            }

            if (asset == null)
            {
                throw new ArgumentNullException(nameof(asset));
            }

            foreach (ZamgunePlayInput input in inputs)
            {
                if (!TryParseInputType(input.Type, out ZamgunePlayInputType inputType))
                {
                    throw new ArgumentException($"Input type for '{input.Action}' must be 'press' or 'hold'.");
                }

                InputAction action = asset.FindAction(input.Action, false);
                if (action == null)
                {
                    _warnings.Add($"InputAction '{input.Action}' was not found in '{asset.name}'.");
                    continue;
                }

                if (!_action_enabled_before.ContainsKey(action))
                {
                    _action_enabled_before[action] = action.enabled;
                }

                if (!action.enabled)
                {
                    action.Enable();
                }

                if (!InjectActionValue(action, 1f))
                {
                    _warnings.Add($"InputAction '{input.Action}' has no resolved control.");
                    continue;
                }

                _actions_to_release.Add(action);
                if (inputType == ZamgunePlayInputType.Hold)
                {
                    _held_actions.Add(action);
                }
                else
                {
                    _press_actions.Add(action);
                }

                _applied_inputs.Add($"{input.Action}:{input.Type.ToLowerInvariant()}");
            }

            InputSystem.Update();
        }

        internal void ReleasePressInputs()
        {
            ReleaseActions(_press_actions);
        }

        internal void RefreshHeldInputs()
        {
            foreach (InputAction action in _held_actions)
            {
                InjectActionValue(action, 1f);
            }

            if (_held_actions.Count > 0)
            {
                InputSystem.Update();
            }
        }

        internal bool InjectActionValue(InputAction action, float value)
        {
            if (action == null || action.controls.Count == 0)
            {
                return false;
            }

            InputControl control = action.controls[0];
            if (control is KeyControl keyControl && keyControl.device is Keyboard keyboard)
            {
                QueueKeyboardStateEvent(keyboard, keyControl.keyCode, value > 0f);
                return true;
            }

            if (control is ButtonControl buttonControl)
            {
                using (StateEvent.From(buttonControl.device, out InputEventPtr eventPtr))
                {
                    buttonControl.WriteValueIntoEvent(value > 0f ? 1f : 0f, eventPtr);
                    InputSystem.QueueEvent(eventPtr);
                }

                return true;
            }

            if (control is AxisControl axisControl)
            {
                InputSystem.QueueDeltaStateEvent(axisControl, value);
                return true;
            }

            using (StateEvent.From(control.device, out InputEventPtr fallbackEventPtr))
            {
                control.WriteValueIntoEvent(value, fallbackEventPtr);
                InputSystem.QueueEvent(fallbackEventPtr);
            }

            return true;
        }

        internal void ResetAllInputDevices()
        {
            foreach (InputDevice device in InputSystem.devices)
            {
                if (device == null)
                {
                    continue;
                }

                try
                {
                    InputSystem.ResetDevice(device);
                }
                catch (Exception ex)
                {
                    _warnings.Add($"Could not reset input device '{device.name}': {ex.Message}");
                }
            }

            _active_keys_by_keyboard.Clear();
        }

        internal static bool TryParseInputType(string value, out ZamgunePlayInputType inputType)
        {
            inputType = ZamgunePlayInputType.Press;
            if (string.Equals(value?.Trim(), "press", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (string.Equals(value?.Trim(), "hold", StringComparison.OrdinalIgnoreCase))
            {
                inputType = ZamgunePlayInputType.Hold;
                return true;
            }

            return false;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            try
            {
                try
                {
                    ReleaseActions(_actions_to_release);
                }
                catch (Exception ex)
                {
                    _warnings.Add($"Could not release injected input actions: {ex.Message}");
                }

                ResetAllInputDevices();

                foreach (KeyValuePair<InputAction, bool> actionState in _action_enabled_before)
                {
                    if (!actionState.Value && actionState.Key != null && actionState.Key.enabled)
                    {
                        try
                        {
                            actionState.Key.Disable();
                        }
                        catch (Exception ex)
                        {
                            _warnings.Add($"Could not restore InputAction '{actionState.Key.name}': {ex.Message}");
                        }
                    }
                }

                foreach (InputDevice device in _reenabled_devices.Where(device => device != null))
                {
                    try
                    {
                        InputSystem.DisableDevice(device);
                    }
                    catch (Exception ex)
                    {
                        _warnings.Add($"Could not restore disabled device '{device.name}': {ex.Message}");
                    }
                }
            }
            finally
            {
                if (_prepared)
                {
                    try
                    {
                        InputSystem.settings.backgroundBehavior = _previous_background_behavior;
                    }
                    catch (Exception ex)
                    {
                        _warnings.Add($"Could not restore Input System background behavior: {ex.Message}");
                    }

                    try
                    {
                        InputSystem.settings.editorInputBehaviorInPlayMode = _previous_editor_input_behavior;
                    }
                    catch (Exception ex)
                    {
                        _warnings.Add($"Could not restore Input System Editor behavior: {ex.Message}");
                    }

                    try
                    {
                        Application.runInBackground = _previous_run_in_background;
                    }
                    catch (Exception ex)
                    {
                        _warnings.Add($"Could not restore Application.runInBackground: {ex.Message}");
                    }
                }

                _active_keys_by_keyboard.Clear();
                _actions_to_release.Clear();
                _press_actions.Clear();
                _held_actions.Clear();
                _action_enabled_before.Clear();
                _reenabled_devices.Clear();
            }
        }

        internal static void ResetEveryInputDevice()
        {
            foreach (InputDevice device in InputSystem.devices)
            {
                if (device != null)
                {
                    try
                    {
                        InputSystem.ResetDevice(device);
                    }
                    catch
                    {
                        // Best-effort cleanup during lifecycle transitions.
                    }
                }
            }
        }

        private void QueueKeyboardStateEvent(Keyboard keyboard, Key key, bool pressed)
        {
            if (!_active_keys_by_keyboard.TryGetValue(keyboard, out HashSet<Key> activeKeys))
            {
                activeKeys = new HashSet<Key>();
                _active_keys_by_keyboard[keyboard] = activeKeys;
            }

            if (pressed)
            {
                activeKeys.Add(key);
            }
            else
            {
                activeKeys.Remove(key);
            }

            InputSystem.QueueStateEvent(keyboard, new KeyboardState(activeKeys.ToArray()));
        }

        private void ReleaseActions(ICollection<InputAction> actions)
        {
            if (actions == null || actions.Count == 0)
            {
                return;
            }

            foreach (InputAction action in actions.ToArray())
            {
                InjectActionValue(action, 0f);
            }

            InputSystem.Update();
            actions.Clear();
        }
    }
}
