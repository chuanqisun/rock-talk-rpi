# RockTalk Operator Manual

> [!WARNING]
> Leaving the USB audio device plugged-in while rebooting will cause crash.

> [!WARNING]
> Leaving RFID chip on the reader while rebooting may cause crash.

> [!TIP]
> Typical reboot time is 25 seconds

## Add audio tracks

- Use mp3 audio format
- Mount the MicroSD card to your laptop, copy paste mp3 files into the `/home/rocktalk/rocktalk-pi/tracks` folder.
- Update `/home/rocktalk/rocktalk-pi/map.json` to map each track to a RFID chip UID.

## Identify the RFID chip UIDs

Ask the project developer for ssh password. Connect to dock via USB-C port, then ssh onto the device.

```sh
ssh rocktalk@rocktalk.local
cd ~/rocktalk-pi
sudo systemctl stop rocktalk.service
node setup.js
```

Follow the instructions to test each RFID chip and note down the UID. After testing, restart the service.

```sh
sudo systemctl restart rocktalk.service
```

## Using the dock

The system will auto start the program on boot. Move the RFID chip into the sensor field. If the chip UID exists in `map.json`, the mapped track will loop. If not, the `"*"` fallback track will loop. The audio output will be piped into the first USB audio device detected by the system. It is ok to unplug and replug the USB audio device while the system is running.

## Developer task: first-time setup of Raspberry Pi

### 0. Create Raspberry Pi image

Use Raspberry Pi Imager to flash the latest Raspberry Pi OS Lite (64-bit) to your microSD card.

- Enable WIFI to use MLDEV (or any basic username/password WIFI)
- Enable [Raspberry Pi Connect](https://www.raspberrypi.com/software/connect/) during the installation

### 1. Enable SSH over USB

- [Full documentation for reference](https://www.raspberrypi.com/news/usb-gadget-mode-in-raspberry-pi-os-ssh-over-usb/)
- The setup requires internet sharing from the host laptop to the Raspberry Pi. Windows and MacOS require additional setup. See the documentation for details.
- After initial boot, use Raspberry Pi Connect to open a terminal over the WIFI. Then run the following commands to enable SSH over USB

```sh
sudo apt update
sudo apt install rpi-usb-gadget
sudo rpi-usb-gadget on
sudo reboot
```

After this step, you can switch to use USB-C cable for local programming. In your host computer, connect to raspberry pi using the following command.

```sh
ssh <username>@<hostname>.local
```

### 2. Enable SPI

```sh
sudo raspi-config
# Follow the menu to enable SPI interface
sudo reboot
```

### 3. Install packages

```sh
sudo apt install mpg123 # for playing mp3 audio
```

### 4. Test hardware

```sh
aplay -L  # list audio devices
speaker-test -D plughw:Audio,0 -c 2 -t wav # do you hear sound?
ls /dev/spidev* # is rfid reader connected? if successful, you should see something like /dev/spidev0.0 and /dev/spidev0.1
```

### 5. Install nvm

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Need to logout, login again
nvm install 24
```

### 6. Clone repo

```sh
sudo apt install git
git clone https://github.com/chuanqisun/rocktalk-pi.git
```

6. Install dependencies

```sh
cd rocktalk-pi

#  setup node dependencies
npm init -y
npm install spi-device rxjs @clack/prompts --no-save
```

### 7. Auto startup

This allows the app to auto-start on boot, without connecting to a computer

```sh
sudo cp rocktalk.service /etc/systemd/system/

# stop and disable the default service if it exists
sudo systemctl daemon-reload
sudo systemctl enable rocktalk.service
sudo systemctl start rocktalk.service
```

## NeoPixel setup

### 1. Install pip

```sh
sudo apt install python3-pip
```

### 2. Create virtual environment

```sh
sudo apt install python3-venv
python3 -m venv env --system-site-packages
source env/bin/activate
```

Follow this [documentation](https://learn.adafruit.com/circuitpython-on-raspberrypi-linux/using-neopixels-on-the-pi-5) to finish the setup

The Node.js LED launcher will automatically use `env/bin/python3` when the project-level `env` virtual environment exists. If you need to override that, set `ROCKTALK_LED_PYTHON` to the interpreter you want.

## Troubleshoot

1. The device no longer auto-connects to WIFI. Run `sudo raspi-config` to set up WIFI again.
2. Power LED turns red. Power off the device and power on again. You may need to unplug USB devices during the reboot.
