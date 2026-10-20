import QtQuick.Layouts

Item {
	anchors.fill: parent

	Column {
		width: parent.width
		height: parent.height
		spacing: 10

		Pane {
			width: parent.width
			height: 160

			background: Rectangle {
				color: "#070d16"
				radius: 8
				border.color: "#18232e"
				border.width: 1.5
			}

			ColumnLayout {
				anchors.fill: parent
				spacing: 8

				Text {
					Layout.fillWidth: true
					color: "White"
					text: "LIFX LAN Discovery"
					font.family: theme.primaryfont
					font.weight: Font.Bold
					font.pixelSize: 24
				}

				Text {
					Layout.fillWidth: true
					color: theme.secondarytextcolor
					text: "Lights are controlled locally over UDP 56700. Enter one or more IPv4 addresses, comma separated, and press Check IP - addresses from your router's device list work well. Or enter just the first three numbers (for example 192.168.0) and press Sweep Subnet."
					wrapMode: Text.WordWrap
					font.family: theme.secondaryfont
					font.pixelSize: 13
				}

				RowLayout {
					Layout.fillWidth: true
					spacing: 8

					TextField {
						id: manualIp
						Layout.preferredWidth: 220
						Layout.preferredHeight: 40
						placeholderText: "192.168.0.50, .51  or  192.168.0"
						color: theme.secondarytextcolor
						font.family: theme.secondaryfont
						// Digits, dots, commas and spaces: one address, a pasted
						// list of them, or a bare subnet prefix to sweep.
						validator: RegularExpressionValidator {
							regularExpression: /^[0-9., ]{0,255}$/
						}
						background: Rectangle {
							color: theme.background3
							radius: 4
						}
					}

					SButton {
						Layout.preferredWidth: 100
						Layout.preferredHeight: 40
						color: hovered ? Qt.darker("#5664b1", 1.5) : "#5664b1"
						label.text: "Check IP"
						onClicked: discovery.checkIP(manualIp.text)
					}

					SButton {
						Layout.preferredWidth: 130
						Layout.preferredHeight: 40
						color: hovered ? Qt.darker("#5664b1", 1.5) : "#5664b1"
						label.text: "Sweep Subnet"
						onClicked: discovery.sweepSubnet(manualIp.text)
					}

					SButton {
						Layout.preferredWidth: 100
						Layout.preferredHeight: 40
						color: hovered ? Qt.darker("#304152", 1.5) : "#304152"
						label.text: "Scan Now"
						onClicked: discovery.scanNow()
					}

					Item { Layout.fillWidth: true }
				}
			}
		}

		ScrollView {
			width: parent.width
			height: parent.height - y
			clip: true
			ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

			Grid {
				id: deviceGrid
				width: parent.parent.width
				columns: Math.max(1, Math.floor(width / 350))
				spacing: 10

				property int itemWidth: (width - (columns - 1) * spacing) / columns

				Repeater {
					model: service.controllers

					delegate: Pane {
						id: card
						width: deviceGrid.itemWidth
						height: 145
						padding: 12

						property var light: model.modelData.obj

						// Captured as plain strings. Handing the whole light object
						// to a discovery callback does not survive the QML/JS
						// boundary - it arrives as undefined, which made Link throw
						// "cannot read property 'id' of undefined" and made Remove
						// quietly do nothing.
						property string lightId: card.light && card.light.id ? String(card.light.id) : ""

						background: Rectangle {
							color: "#070d16"
							radius: 8
							border.color: "#18232e"
							border.width: 2
						}

						ColumnLayout {
							anchors.fill: parent
							spacing: 3

							Text {
								Layout.fillWidth: true
								color: theme.primarytextcolor
								text: card.light.name
								elide: Text.ElideRight
								font.family: theme.primaryfont
								font.weight: Font.Bold
								font.pixelSize: 18
							}

							Text {
								Layout.fillWidth: true
								color: theme.secondarytextcolor
								text: card.light.model
								elide: Text.ElideRight
								font.family: theme.secondaryfont
								font.pixelSize: 12
							}

							Text {
								Layout.fillWidth: true
								color: theme.secondarytextcolor
								text: "IP: " + card.light.ip + "   ID: " + card.light.id
								elide: Text.ElideRight
								font.family: theme.secondaryfont
								font.pixelSize: 12
							}

							Item { Layout.fillHeight: true }

							RowLayout {
								Layout.fillWidth: true

								SButton {
									Layout.preferredWidth: 120
									Layout.preferredHeight: 34
									color: card.light.paired
										? (hovered ? Qt.darker("#394e61", 1.5) : "#394e61")
										: (hovered ? Qt.darker("#5664b1", 1.5) : "#5664b1")
									label.text: card.light.paired ? "Unlink" : "Link"
									onClicked: card.light.paired
										? discovery.unlink(card.lightId)
										: discovery.link(card.lightId)
								}

								Item { Layout.fillWidth: true }

								SButton {
									Layout.preferredWidth: 90
									Layout.preferredHeight: 34
									color: hovered ? Qt.darker("#531b1b", 1.5) : "#531b1b"
									label.text: "Remove"
									onClicked: discovery.remove(card.lightId)
								}
							}
						}
					}
				}
			}
		}
	}
}
