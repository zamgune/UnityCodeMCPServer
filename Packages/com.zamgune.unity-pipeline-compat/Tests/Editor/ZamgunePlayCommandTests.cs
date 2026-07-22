using System;
using System.Reflection;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class ZamgunePlayCommandTests
    {
        [Test]
        public void Commands_ExposeExpectedPipelineNamesAndAsyncStep()
        {
            MethodInfo begin = typeof(ZamgunePlayCommands).GetMethod(nameof(ZamgunePlayCommands.Begin));
            MethodInfo step = typeof(ZamgunePlayCommands).GetMethod(nameof(ZamgunePlayCommands.Step));
            MethodInfo end = typeof(ZamgunePlayCommands).GetMethod(nameof(ZamgunePlayCommands.End));

            Assert.That(begin, Is.Not.Null);
            Assert.That(step, Is.Not.Null);
            Assert.That(end, Is.Not.Null);
            Assert.That(begin.GetCustomAttribute<CliCommandAttribute>()?.Name, Is.EqualTo("zamgune_play_begin"));
            Assert.That(step.GetCustomAttribute<CliCommandAttribute>()?.Name, Is.EqualTo("zamgune_play_step"));
            Assert.That(end.GetCustomAttribute<CliCommandAttribute>()?.Name, Is.EqualTo("zamgune_play_end"));
            Assert.That(step.ReturnType, Is.EqualTo(typeof(Task<ZamgunePlayStepResponse>)));
            Assert.That(typeof(IStructuredCommandInput).IsAssignableFrom(typeof(ZamgunePlayStepOptions)), Is.True);
            Assert.That(typeof(IStructuredCommandInput).IsAssignableFrom(typeof(ZamgunePlayInput)), Is.True);
        }

        [Test]
        public void StructuredJson_MapsSnakeCaseFields()
        {
            const string json =
                "{\"duration_ms\":1250,\"input_action_asset_path\":\"Assets/Test.inputactions\"," +
                "\"inputs\":[{\"action\":\"Player/Jump\",\"type\":\"press\"}]}";

            ZamgunePlayStepOptions options = JsonConvert.DeserializeObject<ZamgunePlayStepOptions>(json);

            Assert.That(options, Is.Not.Null);
            Assert.That(options.DurationMs, Is.EqualTo(1250));
            Assert.That(options.InputActionAssetPath, Is.EqualTo("Assets/Test.inputactions"));
            Assert.That(options.Inputs, Has.Count.EqualTo(1));
            Assert.That(options.Inputs[0].Action, Is.EqualTo("Player/Jump"));
            Assert.That(options.Inputs[0].Type, Is.EqualTo("press"));
            Assert.That(ZamgunePlayCommands.ValidateOptions(options), Is.Null);
        }

        [TestCase(-1, "duration_ms")]
        [TestCase(0, null)]
        [TestCase(300001, "300000")]
        public void ValidateOptions_EnforcesDurationRange(int durationMs, string expectedMessageFragment)
        {
            var options = new ZamgunePlayStepOptions { DurationMs = durationMs };

            string error = ZamgunePlayCommands.ValidateOptions(options);

            if (expectedMessageFragment == null)
            {
                Assert.That(error, Is.Null);
            }
            else
            {
                StringAssert.Contains(expectedMessageFragment, error);
            }
        }

        [Test]
        public void ValidateOptions_RejectsUnsupportedInputType()
        {
            var options = new ZamgunePlayStepOptions
            {
                Inputs =
                {
                    new ZamgunePlayInput { Action = "Player/Jump", Type = "toggle" }
                }
            };

            string error = ZamgunePlayCommands.ValidateOptions(options);

            StringAssert.Contains("press", error);
            StringAssert.Contains("hold", error);
        }

        [Test]
        public void EmptyInputs_DoNotRequireAnInputActionAsset()
        {
            var options = new ZamgunePlayStepOptions
            {
                DurationMs = 100,
                InputActionAssetPath = null
            };

            Assert.That(ZamgunePlayCommands.ValidateOptions(options), Is.Null);
            Assert.That(ZamgunePlayCommands.RequiresInputActionAsset(options), Is.False);
        }

        [Test]
        public void ResolvePath_PrefersSortedProjectAssetThenFallback()
        {
            string projectResolved = InputActionAssetResolver.ResolvePath(
                null,
                new[] { "Assets/Z.inputactions", "Assets/A.inputactions" },
                new[] { "Packages/Test.inputactions" },
                out string projectWarning);

            string fallbackResolved = InputActionAssetResolver.ResolvePath(
                null,
                Array.Empty<string>(),
                new[] { "Packages/Z.inputactions", "Packages/A.inputactions" },
                out string fallbackWarning);

            Assert.That(projectResolved, Is.EqualTo("Assets/A.inputactions"));
            StringAssert.Contains("Assets/A.inputactions", projectWarning);
            Assert.That(fallbackResolved, Is.EqualTo("Packages/A.inputactions"));
            StringAssert.Contains("Packages/A.inputactions", fallbackWarning);
        }

        [Test]
        public void InjectActionValue_PreservesSimultaneousKeyboardActionsAndResetClearsThem()
        {
            Keyboard keyboard = InputSystem.AddDevice<Keyboard>();
            InputSystem.SetDeviceUsage(keyboard, CommonUsages.LeftHand);

            var asset = ScriptableObject.CreateInstance<InputActionAsset>();
            var map = new InputActionMap("CompatibilityTests");
            InputAction first = map.AddAction("First", InputActionType.Button, "<Keyboard>{LeftHand}/w");
            InputAction second = map.AddAction("Second", InputActionType.Button, "<Keyboard>{LeftHand}/upArrow");
            asset.AddActionMap(map);
            map.Enable();
            var driver = new PlayInputDriver();
            var firstControl = (KeyControl)first.controls[0];
            var secondControl = (KeyControl)second.controls[0];

            try
            {
                Assert.That(driver.InjectActionValue(first, 1f), Is.True);
                InputSystem.Update();
                Assert.That(driver.InjectActionValue(second, 1f), Is.True);
                InputSystem.Update();

                Assert.That(firstControl.isPressed, Is.True);
                Assert.That(secondControl.isPressed, Is.True);

                driver.ResetAllInputDevices();
                InputSystem.Update();

                Assert.That(firstControl.isPressed, Is.False);
                Assert.That(secondControl.isPressed, Is.False);
            }
            finally
            {
                driver.InjectActionValue(first, 0f);
                driver.InjectActionValue(second, 0f);
                InputSystem.Update();
                map.Disable();
                UnityEngine.Object.DestroyImmediate(asset);

                if (keyboard != null && keyboard.added)
                {
                    InputSystem.RemoveDevice(keyboard);
                }
            }
        }
    }
}
